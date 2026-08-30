use crate::osc::query::{LiveQuery, QueryError};
use crate::tools::clip_notes::{self, ClipNotes, ARRANGEMENT_NOTES};
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// Deliberately equal to `clips::QUERY_TIMEOUT` and for the same reason: the
/// poll loop calls `RequestTable::expire` on that window every tick and
/// expiry drops the waiter, so a longer timeout here could never be reached.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Clips asked for per page. The handler cuts the window down to what fits a
/// datagram, so this is an upper bound, not a promise.
pub const REQUEST_SPAN: usize = 48;

/// Round trips one track's timeline may cost before the read gives up.
/// Bounded so a Live that is not answering costs a fixed number of requests
/// rather than an unbounded sweep.
pub const MAX_WINDOWS: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArrangementClip {
    /// Position in the track's `arrangement_clips` list, and exactly what
    /// `get_arrangement_notes` takes. Not a bar number and not a slot.
    pub index: i32,
    /// Absent when the clip has no name, rather than an empty fence.
    ///
    /// Probed against Live 12 on 2026-08-30: a track with nine arrangement
    /// clips answered every name as an empty string. Live shows a derived
    /// label in the timeline and leaves `clip.name` unset, so unnamed is the
    /// normal case there -- the opposite of session slots, which producers
    /// do name. `fence("")` is `«»`, and sending that per clip costs tokens
    /// on every call and reads to the model as a name it can quote back at
    /// the producer. Omitted instead, the way `TrackClips::midi` omits an
    /// unknown flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// f64, not f32: `json!` widens an f32 by casting its raw bits, which
    /// keeps the f32 rounding error (an off-grid clip start would reach the
    /// model as `31.999998092651367`, in the same turn the SECTIONS line
    /// prints `32`). Decoded through `clip_notes::as_f64`'s shortest-decimal
    /// round-trip for the same reason `deltas::to_json` and `clip_notes`
    /// itself do.
    pub start: f64,
    pub length: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackArrangement {
    pub track: i32,
    /// Empty means the track genuinely has nothing on the timeline, which is
    /// the normal state early in the writing phase. Never "we could not read
    /// it" -- that is what `ArrangementMap::missing` says.
    pub clips: Vec<ArrangementClip>,
    /// The read stopped before the track's real clip count was reached.
    pub truncated: bool,
    /// Two pages of this track reported different clip counts, so the
    /// timeline moved while it was being read. The clips listed are real
    /// records Live sent, but an insertion earlier in the timeline shifts
    /// every index after it, so a name here may sit beside another clip's
    /// position. Distinct from `truncated`: that read is short but
    /// consistent, this one may be neither.
    pub changed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArrangementMap {
    pub tracks: Vec<TrackArrangement>,
    /// Asked, no usable answer. Named rather than dropped: a silently short
    /// list reads as "those tracks are empty", which is the wrong answer
    /// rather than a missing one.
    pub missing: Vec<i32>,
    /// Tracks whose `changed` flag is set, gathered here so `execute` can
    /// name them in `missing_reason` the way it names `missing`. "The
    /// timeline moved under the read" and "the track never answered" are
    /// different things to tell a model, which is why this is not folded
    /// into `missing`.
    pub changed: Vec<i32>,
}

/// `(track, start, total, *(name, start_time, length))`.
///
/// Returns `(start, total, clips)` with each clip's index already resolved
/// from the page offset, or `None` if the reply is not the page that was
/// asked for or does not decode cleanly. Fails closed on a ragged triple:
/// guessing which field is missing would invent a timeline, and the model
/// sends these indices back to read notes.
fn decode_page(reply: &[OscType], expect_start: usize) -> Option<(usize, usize, Vec<ArrangementClip>)> {
    let int_at = |i: usize| match reply.get(i)? {
        OscType::Int(v) => Some(*v),
        _ => None,
    };
    let start = usize::try_from(int_at(1)?).ok()?;
    if start != expect_start {
        return None;
    }
    let total = usize::try_from(int_at(2)?).ok()?;

    let fields = reply.get(3..)?;
    if fields.len() % 3 != 0 {
        return None;
    }
    let mut clips = Vec::with_capacity(fields.len() / 3);
    for (offset, triple) in fields.chunks_exact(3).enumerate() {
        let name = match &triple[0] {
            OscType::String(s) if s.is_empty() => None,
            OscType::String(s) => Some(fence(s)),
            _ => return None,
        };
        clips.push(ArrangementClip {
            index: (start + offset) as i32,
            name,
            start: clip_notes::as_f64(&triple[1])?,
            length: clip_notes::as_f64(&triple[2])?,
        });
    }
    Some((start, total, clips))
}

/// One track's whole timeline, paged.
///
/// `None` means the track did not answer its FIRST page, which is also how
/// "there is no track at that index" arrives: the handler returns None and
/// sends nothing, byte-identical to a lost datagram. A page that fails after
/// that keeps the clips already collected and marks the track `truncated`:
/// they are real records Live sent, and filing the whole track under
/// `missing` would throw away a partial read the model can still use.
pub async fn read_track(q: &LiveQuery, track: i32, timeout: Duration) -> Option<TrackArrangement> {
    let mut clips: Vec<ArrangementClip> = Vec::new();
    let mut windows = 0usize;
    let mut truncated = false;
    let mut changed = false;
    let mut first_total: Option<usize> = None;

    loop {
        if windows >= MAX_WINDOWS {
            truncated = true;
            break;
        }
        windows += 1;

        let page = q
            .query(
                "/live/mixingpal/get/arrangement",
                vec![
                    OscType::Int(track),
                    OscType::Int(clips.len() as i32),
                    OscType::Int(REQUEST_SPAN as i32),
                ],
                timeout,
            )
            .await
            .ok()
            .as_deref()
            .and_then(|reply| decode_page(reply, clips.len()));

        let Some((_, total, page)) = page else {
            if windows == 1 {
                return None;
            }
            truncated = true;
            break;
        };

        // Every page re-reads the track's clip count, and nothing else
        // compares them. A clip inserted mid-read shifts every index after
        // it, so without this the result reports one clip twice under two
        // indices, never reports the new one, and carries no signal at all.
        // Stop on the disagreement: the clips already collected are real,
        // but the pages they came from describe two different timelines.
        match first_total {
            None => first_total = Some(total),
            Some(first) if first != total => {
                changed = true;
                // The read stops here, so say whether it also stopped
                // SHORT. `changed` alone would leave `truncated: false`
                // beside a list that never reached the end, which reads as
                // "this is the whole timeline". Computed rather than
                // assumed: a total that shrank can already be covered by
                // what arrived, and claiming a gap nobody observed is the
                // same class of error as filling one in.
                truncated = clips.len() < total;
                break;
            }
            Some(_) => {}
        }

        let empty_page = page.is_empty();
        clips.extend(page);

        if clips.len() >= total {
            break;
        }
        // A page that advanced nothing while the total says there is more
        // would loop until MAX_WINDOWS with no progress. Stop and say the
        // read is short rather than spending the budget on it.
        if empty_page {
            truncated = true;
            break;
        }
    }

    Some(TrackArrangement { track, clips, truncated, changed })
}

/// Every track's timeline, all tracks concurrently.
///
/// Concurrency is the point, not an optimisation, and the reasoning is
/// `device_chains::get_device_chains`'s: `abletonosc/osc_server.py` drains
/// its socket until it blocks, so every pending request is served inside a
/// single Live tick (~100 ms). Each track pages independently inside its own
/// task, so a forty-track set costs one tick per page depth rather than one
/// per track.
///
/// Never returns `Err`. One track failing is one track's worth of missing
/// data, not a failed read of the set.
pub async fn get_arrangement(q: Arc<LiveQuery>, num_tracks: i32, timeout: Duration) -> ArrangementMap {
    let handles: Vec<_> = (0..num_tracks)
        .map(|track| {
            let q = q.clone();
            tokio::spawn(async move { read_track(&q, track, timeout).await })
        })
        .collect();

    let mut tracks = Vec::new();
    let mut missing = Vec::new();
    let mut changed = Vec::new();
    for (index, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Some(entry)) => {
                if entry.changed {
                    changed.push(entry.track);
                }
                tracks.push(entry);
            }
            _ => missing.push(index as i32),
        }
    }
    ArrangementMap { tracks, missing, changed }
}

#[derive(Debug)]
pub enum ArrangementNotesError {
    Query(QueryError),
    /// The clip at this index was not the same clip before and after the
    /// read. Its notes are dropped rather than returned under the wrong name.
    IdentityChanged,
}

/// `(track, index, name, start_time, length)` from
/// `/live/mixingpal/get/arrangement/identity`.
///
/// The echoed `(track, index)` is not re-checked: the address is
/// `KeyArity::Args(2)`, so the request table already refuses a reply that
/// echoes anything else. Same as `device_params::decode_identity`, which
/// this is modelled on.
fn decode_identity(reply: &[OscType]) -> Option<(Option<String>, f64, f64)> {
    let name = match reply.get(2)? {
        OscType::String(s) if s.is_empty() => None,
        OscType::String(s) => Some(fence(s)),
        _ => return None,
    };
    Some((name, clip_notes::as_f64(reply.get(3)?)?, clip_notes::as_f64(reply.get(4)?)?))
}

/// One arrangement clip's identity: what makes "index 3" a particular clip
/// rather than a position.
///
/// On an unnamed timeline -- the normal case, see `ArrangementClip::name` --
/// this degenerates to `(start, length)`, and that is still the half that
/// matters: an insertion earlier in the timeline shifts `start` and leaves
/// any name alone. The name is the weaker discriminator here, not the
/// stronger one, which is why both tests pin `start` as well.
///
/// Its OWN address rather than a span-1 page of the map. The map is keyed on
/// `(track, start)`, so an identity read at index N and a map page starting
/// at N produce the same key: the second registrant JOINS the first and
/// takes its reply, and a page that asked for 48 records is answered with
/// one -- it then advances by one and burns MAX_WINDOWS into a false
/// `truncated`. Today's UI calls tools one at a time, but nothing in the
/// Rust side serialises them. A distinct address cannot collide, and it
/// reads one clip instead of rescanning a track.
async fn identity_of(
    q: &LiveQuery,
    track: i32,
    index: i32,
    timeout: Duration,
) -> Option<(Option<String>, f64, f64)> {
    q.query(
        "/live/mixingpal/get/arrangement/identity",
        vec![OscType::Int(track), OscType::Int(index)],
        timeout,
    )
    .await
    .ok()
    .as_deref()
    .and_then(decode_identity)
}

/// `get_arrangement_notes`'s successful payload: the notes, plus the clip's
/// own name and start.
///
/// The spec calls this "no longer the guard" -- the identity bracket is what
/// rejects a moved clip -- but echoing it back is still useful context for
/// the model, especially when it calls this tool without having called
/// `get_arrangement` first, which the schema permits.
#[derive(Debug, Clone, PartialEq)]
pub struct ArrangementClipNotes {
    /// Absent for an unnamed clip, for the reason `ArrangementClip::name`
    /// records.
    pub name: Option<String>,
    pub start: f64,
    pub notes: ClipNotes,
}

/// Notes in one arrangement clip, bracketed by an identity check.
///
/// The bracket is not defence in depth, it is the guard. Arrangement indices
/// shift when a clip is added earlier in the timeline, so a read spanning
/// that edit lands on a neighbour and returns real notes under the wrong
/// clip's name -- a confident, wrong answer, and one the model has no way to
/// detect. Checking in Rust rather than echoing the identity and hoping the
/// model compares it is the pattern `device_params` and `rack_contents`
/// already use.
pub async fn get_arrangement_notes(
    q: Arc<LiveQuery>,
    track: i32,
    index: i32,
    timeout: Duration,
) -> Result<ArrangementClipNotes, ArrangementNotesError> {
    let before = identity_of(&q, track, index, timeout)
        .await
        .ok_or(ArrangementNotesError::Query(QueryError::NoReply))?;

    let notes = clip_notes::get_notes_at(q.clone(), ARRANGEMENT_NOTES, track, index, timeout)
        .await
        .map_err(ArrangementNotesError::Query)?;

    let after = identity_of(&q, track, index, timeout)
        .await
        .ok_or(ArrangementNotesError::Query(QueryError::NoReply))?;

    if before != after {
        return Err(ArrangementNotesError::IdentityChanged);
    }
    let (name, start, _length) = before;
    Ok(ArrangementClipNotes { name, start, notes })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::sync::Mutex;

    #[test]
    fn decode_page_reads_the_header_then_every_triple() {
        let reply = vec![
            OscType::Int(2),
            OscType::Int(0),
            OscType::Int(7),
            OscType::String("Verse".into()),
            OscType::Float(32.0),
            OscType::Float(64.0),
            OscType::String("Fill".into()),
            OscType::Float(60.0),
            OscType::Float(4.0),
        ];
        let (start, total, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!((start, total), (0, 7));
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].name.as_deref(), Some("«Verse»"));
        assert_eq!((clips[0].start, clips[0].length), (32.0, 64.0));
    }

    #[test]
    fn an_unnamed_arrangement_clip_carries_no_name_at_all() {
        // Probed against Live 12 on 2026-08-30: a track with nine
        // arrangement clips answered `,isssssssss` with every string empty.
        // Live shows a derived label in the timeline and leaves `clip.name`
        // unset, so unnamed is the NORMAL case there, unlike session slots
        // which producers do name. Fencing an empty name yields `«»`, which
        // costs tokens on every clip of every call and reads to the model as
        // a name it can quote back at the producer.
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::String("".into()),
            OscType::Float(32.0),
            OscType::Float(8.0),
        ];
        let (_, _, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!(clips[0].name, None);
        let rendered = serde_json::to_value(&clips[0]).unwrap();
        assert!(rendered.get("name").is_none(), "{rendered}");
        // The position still arrives: it is what carries the information on
        // an unnamed timeline.
        assert_eq!(clips[0].start, 32.0);
    }

    #[test]
    fn a_named_arrangement_clip_still_carries_its_fenced_name() {
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::String("Verse".into()),
            OscType::Float(0.0),
            OscType::Float(4.0),
        ];
        let (_, _, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!(clips[0].name.as_deref(), Some("«Verse»"));
    }

    #[test]
    fn decode_page_refuses_a_page_that_echoes_a_different_start() {
        // Defence in depth. The address is Args(2), keyed on (track, start),
        // so a stale page resolves no pending request -- but a page decoded
        // at the wrong offset would number every clip after it wrongly, and
        // the model sends those numbers back to read notes.
        let reply = vec![OscType::Int(0), OscType::Int(4), OscType::Int(7)];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn decode_page_fails_closed_on_a_ragged_triple() {
        // Guessing which fields are missing would invent a timeline.
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::String("Verse".into()),
            OscType::Float(32.0),
        ];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn decode_page_fails_closed_on_a_non_string_name() {
        // Guessing a name from a non-string field would invent a clip label.
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::Int(7),
            OscType::Float(32.0),
            OscType::Float(64.0),
        ];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn decode_page_fails_closed_on_a_non_numeric_start() {
        // Guessing a position from a non-numeric field would invent where
        // the clip sits on the timeline.
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::String("Verse".into()),
            OscType::String("not a number".into()),
            OscType::Float(64.0),
        ];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn a_track_with_nothing_on_the_timeline_decodes_to_an_empty_page() {
        // Empty is a real answer, and it is the normal one early in the
        // writing phase.
        let reply = vec![OscType::Int(3), OscType::Int(0), OscType::Int(0)];
        let (_, total, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!(total, 0);
        assert!(clips.is_empty());
    }

    /// `timelines[i]` is track i's clips as (name, start, length). `silent`
    /// names tracks that get no reply at all, which is what a lost datagram
    /// looks like from the client's side. `page` is how many records the
    /// fake returns per reply, so a track longer than one page exercises the
    /// paging loop.
    #[derive(Default)]
    struct FakeLive {
        timelines: Vec<Vec<(String, f32, f32)>>,
        silent: Vec<i32>,
        page: usize,
        hold_until_all_arrive: Option<usize>,
        /// Answers at most this many page requests and then goes silent, so
        /// a LATER page fails while earlier ones already landed. Counted
        /// across every track, so the tests using it read one track.
        answer_at_most: Option<usize>,
        /// The clip count reported on every page after the first. A
        /// producer inserting a clip mid-read is what makes the pages
        /// disagree in Live.
        total_after_first: Option<i32>,
    }

    async fn fake_live(fake: FakeLive) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let page = if fake.page == 0 { REQUEST_SPAN } else { fake.page };
            let mut held: Vec<Vec<OscType>> = Vec::new();
            let mut answered = 0usize;
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if req.addr != "/live/mixingpal/get/arrangement" {
                    continue;
                }
                let (track, start) = match (req.args.first(), req.args.get(1)) {
                    (Some(OscType::Int(t)), Some(OscType::Int(s))) => (*t, *s as usize),
                    _ => continue,
                };
                if fake.silent.contains(&track) {
                    continue; // the reply Live could not send
                }
                answered += 1;
                if fake.answer_at_most.is_some_and(|n| answered > n) {
                    continue; // the page that never came back
                }
                let empty: Vec<(String, f32, f32)> = Vec::new();
                let timeline = fake.timelines.get(track as usize).unwrap_or(&empty);
                let total = match fake.total_after_first {
                    Some(t) if answered > 1 => t,
                    _ => timeline.len() as i32,
                };
                let mut reply = vec![
                    OscType::Int(track),
                    OscType::Int(start as i32),
                    OscType::Int(total),
                ];
                for (name, at, len) in timeline.iter().skip(start).take(page) {
                    reply.push(OscType::String(name.clone()));
                    reply.push(OscType::Float(*at));
                    reply.push(OscType::Float(*len));
                }
                if let Some(expect) = fake.hold_until_all_arrive {
                    held.push(reply);
                    if held.len() < expect {
                        continue; // answer nothing until every request is in
                    }
                    for reply in held.drain(..) {
                        let _ = live
                            .send_to(app_port, "/live/mixingpal/get/arrangement", reply)
                            .await;
                    }
                    continue;
                }
                let _ = live
                    .send_to(app_port, "/live/mixingpal/get/arrangement", reply)
                    .await;
            }
        });

        Arc::new(LiveQuery::new(app, table))
    }

    /// Answers the identity read with `first` the first time and `second`
    /// afterwards -- each a `(name, start)` pair, with length held at `8.0`
    /// throughout.
    ///
    /// Two cases exercise this, because Live names an arrangement clip after
    /// its source clip: a track of duplicated loops has many clips all
    /// called e.g. "Drums", so a real insertion does not reliably change the
    /// name. It always changes `start`, though -- everything from the
    /// inserted clip onward slides later on the timeline -- so `start` is
    /// what actually distinguishes index 2 before and after an insertion,
    /// and the two cases below vary the name and the start independently so
    /// neither field alone can make the identity check pass by accident.
    async fn fake_live_with_moving_clip(
        first: (&'static str, f32),
        second: (&'static str, f32),
    ) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let mut seen_identity = 0;
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                match req.addr.as_str() {
                    "/live/mixingpal/get/arrangement/identity" => {
                        seen_identity += 1;
                        let (name, start) = if seen_identity == 1 { first } else { second };
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![
                                    req.args[0].clone(),
                                    req.args[1].clone(),
                                    OscType::String(name.into()),
                                    OscType::Float(start),
                                    OscType::Float(8.0),
                                ],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/length" => {
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![req.args[0].clone(), req.args[1].clone(), OscType::Float(8.0)],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/num_notes" => {
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![req.args[0].clone(), req.args[1].clone(), OscType::Int(1)],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/notes_window" => {
                        let mut reply = vec![
                            req.args[0].clone(),
                            req.args[1].clone(),
                            req.args[2].clone(),
                        ];
                        reply.extend(vec![
                            OscType::Int(60),
                            OscType::Float(0.0),
                            OscType::Float(0.5),
                            OscType::Float(100.0),
                            OscType::Bool(false),
                        ]);
                        let _ = live.send_to(app_port, &req.addr, reply).await;
                    }
                    _ => {}
                }
            }
        });

        Arc::new(LiveQuery::new(app, table))
    }

    fn timeline(names: &[(&str, f32, f32)]) -> Vec<(String, f32, f32)> {
        names.iter().map(|(n, a, l)| ((*n).to_string(), *a, *l)).collect()
    }

    #[tokio::test]
    async fn every_track_request_goes_out_before_any_reply_is_awaited() {
        // The load-bearing performance claim: AbletonOSC serves all pending
        // requests inside one Live tick, so N in flight is one tick.
        let q = fake_live(FakeLive {
            timelines: vec![
                timeline(&[("Beat", 32.0, 64.0)]),
                timeline(&[("Sub", 32.0, 32.0)]),
                timeline(&[]),
            ],
            hold_until_all_arrive: Some(3),
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 3, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks.len(), 3);
        assert!(map.missing.is_empty());
    }

    #[tokio::test]
    async fn a_silent_track_is_named_in_missing_not_reported_empty() {
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&[("Beat", 0.0, 8.0)]), timeline(&[]), timeline(&[])],
            silent: vec![1],
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 3, Duration::from_millis(300)).await;
        assert_eq!(map.missing, vec![1]);
        assert_eq!(map.tracks.iter().map(|t| t.track).collect::<Vec<_>>(), vec![0, 2]);
    }

    #[tokio::test]
    async fn a_long_timeline_is_paged_until_the_total_is_reached() {
        let long: Vec<(&str, f32, f32)> =
            (0..10).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 3,
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks[0].clips.len(), 10);
        assert!(!map.tracks[0].truncated);
        // Indices are the timeline's own, continuous across page boundaries.
        assert_eq!(map.tracks[0].clips[9].index, 9);
    }

    #[tokio::test]
    async fn a_timeline_longer_than_the_window_budget_reports_truncated() {
        // MAX_WINDOWS round trips at one record each cannot reach the total.
        let long: Vec<(&str, f32, f32)> =
            (0..100).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 1,
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert!(map.tracks[0].truncated);
        assert_eq!(map.tracks[0].clips.len(), MAX_WINDOWS);
        assert!(map.missing.is_empty(), "a truncated read is not a missing one");
    }

    #[tokio::test]
    async fn a_page_lost_after_the_first_keeps_what_already_arrived() {
        // `.ok()?` on a later page threw the whole track away, so a read
        // that got three clips back filed the track under `missing` -- which
        // says "asked, no usable answer" about three real clips.
        let long: Vec<(&str, f32, f32)> = (0..10).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 3,
            answer_at_most: Some(1),
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, Duration::from_millis(300)).await;
        assert!(map.missing.is_empty(), "a partial read is not a missing one");
        assert_eq!(map.tracks[0].clips.len(), 3);
        assert!(map.tracks[0].truncated);
        assert!(!map.tracks[0].changed, "nothing said the timeline moved");
    }

    #[tokio::test]
    async fn a_track_whose_first_page_is_lost_is_still_missing() {
        // The other half of the rule above: with nothing collected there is
        // no partial read to keep, and no reply at all is also how "there is
        // no track at that index" arrives.
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&[("Beat", 0.0, 8.0)])],
            answer_at_most: Some(0),
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, Duration::from_millis(300)).await;
        assert_eq!(map.missing, vec![0]);
        assert!(map.tracks.is_empty());
    }

    #[tokio::test]
    async fn pages_that_disagree_on_the_total_report_the_track_as_changed() {
        // Insert a clip mid-read and the pages describe two timelines: the
        // result would report one clip twice under two indices, never
        // report the new one, and carry no signal at all.
        let long: Vec<(&str, f32, f32)> = (0..10).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 3,
            total_after_first: Some(11),
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert_eq!(map.changed, vec![0]);
        assert!(map.tracks[0].changed);
        // The clips already collected are real records Live sent, so they
        // stay -- the reason string is what says they may be inconsistent.
        assert_eq!(map.tracks[0].clips.len(), 3);
        // And the read stopped three clips into eleven, so it is short as
        // well as suspect. `truncated: false` here would read as "this is
        // the whole timeline".
        assert!(map.tracks[0].truncated);
        assert!(map.missing.is_empty(), "a changed timeline is not a missing one");
    }

    #[tokio::test]
    async fn a_stable_timeline_is_never_reported_as_changed() {
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&[("Beat", 0.0, 8.0)])],
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert!(map.changed.is_empty());
        assert!(!map.tracks[0].changed);
    }

    #[test]
    fn decode_identity_refuses_every_reply_it_cannot_vouch_for() {
        use rosc::OscType::{Float, Int, String as S};
        let good = vec![Int(0), Int(2), S("Verse".into()), Float(32.0), Float(8.0)];
        assert_eq!(
            decode_identity(&good),
            Some((Some(fence("Verse")), 32.0, 8.0))
        );

        // Unnamed is the normal case on the timeline, and it must not
        // become the `«»` an empty fence would produce.
        let mut unnamed = good.clone();
        unnamed[2] = S("".into());
        assert_eq!(decode_identity(&unnamed), Some((None, 32.0, 8.0)));

        // Truncated before the name, the start, and the length.
        assert!(decode_identity(&good[..2]).is_none());
        assert!(decode_identity(&good[..3]).is_none());
        assert!(decode_identity(&good[..4]).is_none());

        // A name that is not a string, a position that is not a number.
        // Guessing either would invent the identity the bracket compares.
        let mut wrong_name = good.clone();
        wrong_name[2] = Int(7);
        assert!(decode_identity(&wrong_name).is_none());
        let mut wrong_start = good.clone();
        wrong_start[3] = S("32".into());
        assert!(decode_identity(&wrong_start).is_none());
    }

    #[tokio::test]
    async fn the_identity_read_uses_its_own_address_not_a_span_one_page() {
        // The map is keyed on (track, start), so an identity read phrased as
        // a span-1 page of index N joins a map page starting at N and takes
        // its reply. `fake_live` answers ONLY the map address, so a read
        // that still used it would find a willing answer here; the assert
        // is that this one times out instead.
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&[("Verse", 32.0, 8.0)])],
            ..Default::default()
        })
        .await;
        let err = get_arrangement_notes(q, 0, 0, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(matches!(
            err,
            ArrangementNotesError::Query(QueryError::NoReply)
        ));
    }

    #[tokio::test]
    async fn notes_are_dropped_when_the_clip_at_the_index_was_renamed() {
        // A clip index that survives being reused for a different clip --
        // e.g. the old one deleted and a new one dropped in at the same
        // slot -- keeps its start and length but not its name.
        let q = fake_live_with_moving_clip(("Verse", 32.0), ("Chorus", 32.0)).await;
        let err = get_arrangement_notes(q, 0, 0, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(matches!(err, ArrangementNotesError::IdentityChanged));
    }

    #[tokio::test]
    async fn notes_are_dropped_when_the_clip_at_the_index_shifted_on_the_timeline() {
        // Arrangement indices shift when a clip is added earlier in the
        // timeline. That kind of edit does NOT change the name: Live names
        // an arrangement clip after its source clip, so a track of
        // duplicated loops has many clips all called e.g. "Drums" -- name
        // alone cannot tell one apart from the next. It always changes
        // `start`, which is why an identity check that pinned only the name
        // would miss the failure this bracket exists to prevent: a read
        // taken across the edit returning a neighbour's notes as if they
        // were the asked-for clip's, and one the model cannot detect for
        // itself.
        let q = fake_live_with_moving_clip(("Verse", 32.0), ("Verse", 28.0)).await;
        let err = get_arrangement_notes(q, 0, 0, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(matches!(err, ArrangementNotesError::IdentityChanged));
    }

    #[tokio::test]
    async fn a_stable_clip_returns_its_notes() {
        // Neither existing test above ever exercises the success path:
        // both assert the bracket REJECTS, and `fake_live_with_moving_clip`
        // changes its answer after the first identity read by design. A
        // clip that answers the SAME (name, start) both times -- nothing
        // moved it -- is what most reads look like, and this is the only
        // test that pins the bracket letting one through.
        let q = fake_live_with_moving_clip(("Verse", 32.0), ("Verse", 32.0)).await;
        let result = get_arrangement_notes(q, 0, 0, Duration::from_millis(300)).await.unwrap();
        assert_eq!(result.name.as_deref(), Some("«Verse»"));
        assert_eq!(result.start, 32.0);
        assert_eq!(
            result.notes.notes,
            vec![clip_notes::Note {
                pitch: 60,
                start: 0.0,
                duration: 0.5,
                velocity: 100.0,
                mute: false,
            }]
        );
    }
}
