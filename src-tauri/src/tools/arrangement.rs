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
    pub name: String,
    pub start: f32,
    pub length: f32,
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
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArrangementMap {
    pub tracks: Vec<TrackArrangement>,
    /// Asked, no usable answer. Named rather than dropped: a silently short
    /// list reads as "those tracks are empty", which is the wrong answer
    /// rather than a missing one.
    pub missing: Vec<i32>,
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
            OscType::String(s) => fence(s),
            _ => return None,
        };
        let number = |arg: &OscType| match arg {
            OscType::Float(v) => Some(*v),
            OscType::Int(v) => Some(*v as f32),
            _ => None,
        };
        clips.push(ArrangementClip {
            index: (start + offset) as i32,
            name,
            start: number(&triple[1])?,
            length: number(&triple[2])?,
        });
    }
    Some((start, total, clips))
}

/// One track's whole timeline, paged.
///
/// `None` means the track did not answer at all, which is also how "there is
/// no track at that index" arrives: the handler returns None and sends
/// nothing, byte-identical to a lost datagram.
pub async fn read_track(q: &LiveQuery, track: i32, timeout: Duration) -> Option<TrackArrangement> {
    let mut clips: Vec<ArrangementClip> = Vec::new();
    let mut windows = 0usize;
    let mut truncated = false;

    loop {
        if windows >= MAX_WINDOWS {
            truncated = true;
            break;
        }
        windows += 1;

        let reply = q
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
            .ok()?;

        let (_, total, page) = decode_page(&reply, clips.len())?;
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

    Some(TrackArrangement { track, clips, truncated })
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
    for (index, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Some(entry)) => tracks.push(entry),
            _ => missing.push(index as i32),
        }
    }
    ArrangementMap { tracks, missing }
}

#[derive(Debug)]
pub enum ArrangementNotesError {
    Query(QueryError),
    /// The clip at this index was not the same clip before and after the
    /// read. Its notes are dropped rather than returned under the wrong name.
    IdentityChanged,
}

/// One arrangement clip's identity: what makes "index 3" a particular clip
/// rather than a position.
async fn identity_of(
    q: &LiveQuery,
    track: i32,
    index: i32,
    timeout: Duration,
) -> Option<(String, f32, f32)> {
    let reply = q
        .query(
            "/live/mixingpal/get/arrangement",
            vec![OscType::Int(track), OscType::Int(index), OscType::Int(1)],
            timeout,
        )
        .await
        .ok()?;
    let (_, _, clips) = decode_page(&reply, index as usize)?;
    let clip = clips.first()?;
    Some((clip.name.clone(), clip.start, clip.length))
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
) -> Result<ClipNotes, ArrangementNotesError> {
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
    Ok(notes)
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
        assert_eq!(clips[0].name, "«Verse»");
        assert_eq!((clips[0].start, clips[0].length), (32.0, 64.0));
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
                let empty: Vec<(String, f32, f32)> = Vec::new();
                let timeline = fake.timelines.get(track as usize).unwrap_or(&empty);
                let mut reply = vec![
                    OscType::Int(track),
                    OscType::Int(start as i32),
                    OscType::Int(timeline.len() as i32),
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
                    "/live/mixingpal/get/arrangement" => {
                        seen_identity += 1;
                        let (name, start) = if seen_identity == 1 { first } else { second };
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![
                                    OscType::Int(0),
                                    OscType::Int(0),
                                    OscType::Int(1),
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
}
