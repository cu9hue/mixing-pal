use crate::osc::budget::note_windows;
use crate::osc::query::{LiveQuery, QueryError};
use rosc::OscType;
use serde::Serialize;
use std::collections::VecDeque;
use std::time::Duration;

/// Deliberately equal to `lib.rs`'s `UNKEYED_REQUEST_TIMEOUT`. The poll loop
/// calls `RequestTable::expire` with that window every tick, and expiry drops
/// the waiter, so a longer timeout here could never actually be reached --
/// it would only make this constant a lie about how long the app waits.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// A window whose reply never arrives is split in half and retried, because
/// the two reasons a reply goes missing are indistinguishable on the wire and
/// only one of them gets better with a smaller window: past `MAX_DATAGRAM`,
/// Live's `sendto` raises and the client receives nothing at all.
///
/// Bounded so a Live that is simply not answering costs a fixed number of
/// round trips instead of an exponential sweep of an unresponsive port.
pub const MAX_WINDOWS: usize = 16;
const MIN_WINDOW_BEATS: f32 = 0.25;

/// `get_notes_extended(from_pitch, pitch_span, ..)` covers
/// `[from_pitch, from_pitch + pitch_span)`, so the span is 128 -- upstream's
/// default of 127 silently omits pitch 127.
const PITCH_START: i32 = 0;
const PITCH_SPAN: i32 = 128;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub pitch: i32,
    pub start: f64,
    pub duration: f64,
    pub velocity: f64,
    pub mute: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipNotes {
    pub notes: Vec<Note>,
    /// Set when at least one window never answered even at the floor. The
    /// notes returned are then a real but partial read, and saying so is the
    /// whole point: the model must not present part of a clip as all of it.
    pub missing_reason: Option<String>,
}

fn as_i32(v: &OscType) -> Option<i32> {
    match v {
        OscType::Int(i) => Some(*i),
        OscType::Float(f) => Some(*f as i32),
        _ => None,
    }
}

/// Widens through f32's shortest-decimal Display for the same reason
/// `deltas::to_json` does: a raw bit-cast keeps f32's rounding error, so
/// 0.5_f32 would arrive as 0.5 but 100.1_f32 as 100.09999847412109.
fn as_f64(v: &OscType) -> Option<f64> {
    match v {
        OscType::Float(f) => f.to_string().parse::<f64>().ok(),
        OscType::Double(d) => Some(*d),
        OscType::Int(i) => Some(*i as f64),
        _ => None,
    }
}

fn as_bool(v: &OscType) -> Option<bool> {
    match v {
        OscType::Bool(b) => Some(*b),
        OscType::Int(i) => Some(*i != 0),
        _ => None,
    }
}

/// Reply shape: `(track_index, clip_index, *note_attributes)` -- see
/// `abletonosc/clip.py`'s `create_clip_callback`, which prepends both
/// indices, and `clip_get_notes`, which flattens each note to
/// `pitch, start_time, duration, velocity, mute`.
pub fn decode_notes(args: &[OscType]) -> Option<Vec<Note>> {
    let body = args.get(2..)?;
    if body.len() % 5 != 0 {
        return None;
    }
    body.chunks_exact(5)
        .map(|c| {
            Some(Note {
                pitch: as_i32(&c[0])?,
                start: as_f64(&c[1])?,
                duration: as_f64(&c[2])?,
                velocity: as_f64(&c[3])?,
                mute: as_bool(&c[4])?,
            })
        })
        .collect()
}

/// Fetches every note in a clip, paging by time window.
///
/// Windows are fetched strictly one at a time. `/live/clip/get/notes` is
/// `KeyArity::Args(2)` -- the reply echoes only `(track, clip)` -- so two
/// windows of the SAME clip in flight would be indistinguishable, and the
/// second would in fact `Joined` the first and never be sent. Serial is not
/// a simplification here; it is the only correct shape.
pub async fn get_clip_notes(
    q: &LiveQuery,
    track: i32,
    clip: i32,
    timeout: Duration,
) -> Result<ClipNotes, QueryError> {
    // An empty clip slot makes `clip` None inside the handler, which raises
    // and answers nothing -- so this failing is also how "there is no clip
    // here" reaches the caller, distinct from "the clip has no notes".
    let length_reply = q
        .query(
            "/live/clip/get/length",
            vec![OscType::Int(track), OscType::Int(clip)],
            timeout,
        )
        .await?;
    // A reply that arrived but whose length value can't be read is not "the
    // clip is empty" -- unwrap_or(0.0) would turn an unreadable reply into a
    // fabricated zero-span window, which returns {notes: [], missing_reason:
    // null}, i.e. an invented "this clip is empty" the reply never said.
    let length = length_reply.get(2).and_then(as_f64).ok_or(QueryError::NoReply)? as f32;

    // With no note-count estimate to work from, start with one window over
    // the whole clip; note_windows returns exactly that for est_notes = 0.
    let mut queue: VecDeque<(f32, f32)> = note_windows(length, 0).into_iter().collect();
    let mut notes: Vec<Note> = Vec::new();
    let mut missing_reason = None;
    let mut windows_used = 0usize;

    while let Some((start, span)) = queue.pop_front() {
        if windows_used >= MAX_WINDOWS {
            missing_reason = Some("too_large".to_string());
            break;
        }
        windows_used += 1;

        let args = vec![
            OscType::Int(track),
            OscType::Int(clip),
            OscType::Int(PITCH_START),
            OscType::Int(PITCH_SPAN),
            OscType::Float(start),
            OscType::Float(span),
        ];
        match q.query("/live/clip/get/notes", args, timeout).await {
            Ok(reply) => match decode_notes(&reply) {
                // `/live/clip/get/notes` is KeyArity::Args(2): the reply
                // echoes only (track, clip), not the window. A late reply
                // for a since-cancelled window can therefore resolve a
                // DIFFERENT, currently in-flight window's waiter -- see this
                // function's doc comment. Live's ranged query form is
                // start-time keyed, so a correct reply only ever contains
                // notes inside [start, start + span); dropping anything
                // outside that range is a no-op on a correct reply and
                // discards a mis-attributed one instead of merging it in.
                Some(mut window) => {
                    let window_start = start as f64;
                    let window_end = window_start + span as f64;
                    window.retain(|n| n.start >= window_start && n.start < window_end);
                    notes.append(&mut window)
                }
                None => missing_reason = Some("malformed_reply".to_string()),
            },
            // Halve and retry: the reply may simply have been too large for
            // one datagram. Windows tile as [start, start + span), so the
            // halves neither overlap nor leave a gap.
            Err(QueryError::NoReply) if span > MIN_WINDOW_BEATS => {
                let half = span / 2.0;
                queue.push_front((start + half, span - half));
                queue.push_front((start, half));
            }
            Err(QueryError::NoReply) => missing_reason = Some("too_large".to_string()),
            Err(e) => return Err(e),
        }
    }

    notes.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.pitch.cmp(&b.pitch))
    });
    Ok(ClipNotes { notes, missing_reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn note_values(pitch: i32, start: f32) -> Vec<OscType> {
        vec![
            OscType::Int(pitch),
            OscType::Float(start),
            OscType::Float(0.5),
            OscType::Float(100.0),
            OscType::Bool(false),
        ]
    }

    #[test]
    fn decode_notes_reads_each_note_past_the_two_echoed_indices() {
        // create_clip_callback prepends (track_index, clip_index) to every
        // clip reply; clip_get_notes then flattens pitch, start_time,
        // duration, velocity, mute per note.
        let mut args = vec![OscType::Int(2), OscType::Int(1)];
        args.extend(note_values(60, 0.0));
        args.extend(note_values(64, 1.0));

        let notes = decode_notes(&args).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0], Note { pitch: 60, start: 0.0, duration: 0.5, velocity: 100.0, mute: false });
        assert_eq!(notes[1].pitch, 64);
        assert_eq!(notes[1].start, 1.0);
    }

    #[test]
    fn decode_notes_fails_closed_when_the_body_is_not_a_multiple_of_five() {
        // A misaligned decode would invent notes at wrong pitches -- exactly
        // the plausible-wrong-data this codebase refuses to produce.
        let mut args = vec![OscType::Int(2), OscType::Int(1)];
        args.extend(note_values(60, 0.0));
        args.pop();
        assert!(decode_notes(&args).is_none());
    }

    /// A scripted stand-in for Live. `silent` names the `(time_start,
    /// time_span)` windows it must not answer -- which is what an oversized
    /// reply actually looks like from the client's side.
    ///
    /// `silent_all` exists because enumerating "every window" by hand is a
    /// trap: the splitter halves 16 into 8, 4, 2, 1, 0.5, 0.25, and a
    /// hand-written list that misses any of those spans lets the fake answer
    /// an intermediate window. The test then returns notes and a `None`
    /// missing_reason while its name says the opposite.
    struct FakeLive {
        length: f32,
        notes: Vec<(f32, i32)>,
        silent: Vec<(f32, f32)>,
        silent_all: bool,
        /// When set, replies to EVERY `/live/clip/get/notes` request with
        /// this exact set of notes, ignoring the requested window entirely
        /// -- a stand-in for a late reply that resolves the wrong window's
        /// waiter (see `get_clip_notes`'s doc comment and IMPORTANT 1 in the
        /// 2026-08-16 whole-branch review).
        full_reply: Option<Vec<(f32, i32)>>,
        /// When set, replies to `/live/clip/get/length` with a value that
        /// cannot be read as a number, instead of `fake.length`.
        malformed_length: bool,
    }

    /// Spawns the fake, plus the receive loop the query path needs, and
    /// returns a LiveQuery pointed at it along with a per-address request
    /// counter so a test can assert the number of round trips.
    async fn spawn(fake: FakeLive) -> (Arc<LiveQuery>, Arc<Mutex<HashMap<String, usize>>>) {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));
        let counts = Arc::new(Mutex::new(HashMap::new()));

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

        let seen = counts.clone();
        tokio::spawn(async move {
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                *seen.lock().unwrap().entry(req.addr.clone()).or_insert(0) += 1;
                let f = |i: usize| match req.args.get(i) {
                    Some(OscType::Float(v)) => *v,
                    Some(OscType::Int(v)) => *v as f32,
                    _ => 0.0,
                };
                match req.addr.as_str() {
                    "/live/clip/get/length" => {
                        let length_arg = if fake.malformed_length {
                            OscType::String("not a number".to_string())
                        } else {
                            OscType::Float(fake.length)
                        };
                        let _ = live
                            .send_to(
                                app_port,
                                "/live/clip/get/length",
                                vec![req.args[0].clone(), req.args[1].clone(), length_arg],
                            )
                            .await;
                    }
                    "/live/clip/get/notes" => {
                        let (start, span) = (f(4), f(5));
                        let silent = fake.silent_all
                            || fake.silent.iter().any(|(s, p)| {
                                (s - start).abs() < 1e-3 && (p - span).abs() < 1e-3
                            });
                        if silent {
                            continue; // the reply Live could not send
                        }
                        let mut reply = vec![req.args[0].clone(), req.args[1].clone()];
                        if let Some(all) = &fake.full_reply {
                            // Ignores the requested window on purpose --
                            // simulates a reply whose notes don't match the
                            // window it's keyed to resolve.
                            for (at, pitch) in all {
                                reply.extend(note_values(*pitch, *at));
                            }
                        } else {
                            for (at, pitch) in &fake.notes {
                                if *at >= start && *at < start + span {
                                    reply.extend(note_values(*pitch, *at));
                                }
                            }
                        }
                        let _ = live.send_to(app_port, "/live/clip/get/notes", reply).await;
                    }
                    _ => {}
                }
            }
        });

        (Arc::new(LiveQuery::new(app, table)), counts)
    }

    const FAST: Duration = Duration::from_millis(80);

    #[tokio::test]
    async fn a_clip_that_answers_in_one_window_returns_every_note() {
        let (q, seen) = spawn(FakeLive {
            length: 16.0,
            notes: vec![(0.0, 60), (4.0, 63), (8.0, 67)],
            silent: vec![],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
        })
        .await;

        let result = get_clip_notes(&q, 2, 1, FAST).await.unwrap();
        assert_eq!(result.notes.len(), 3);
        assert_eq!(result.missing_reason, None);
        assert_eq!(
            seen.lock().unwrap().get("/live/clip/get/notes"),
            Some(&1),
            "a clip that fits must cost exactly one round trip"
        );
    }

    #[tokio::test]
    async fn an_unanswered_window_is_halved_and_retried() {
        // The full 16-beat window is the one Live cannot send. Both halves
        // answer, and every note must survive reassembly.
        let (q, _seen) = spawn(FakeLive {
            length: 16.0,
            notes: vec![(0.0, 60), (4.0, 63), (8.0, 67), (12.0, 70)],
            silent: vec![(0.0, 16.0)],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
        })
        .await;

        let result = get_clip_notes(&q, 2, 1, FAST).await.unwrap();
        assert_eq!(result.missing_reason, None, "the halves answered, so nothing is missing");
        assert_eq!(
            result.notes.iter().map(|n| n.pitch).collect::<Vec<_>>(),
            vec![60, 63, 67, 70],
            "notes from both halves, in time order, with no gap or duplicate"
        );
    }

    #[tokio::test]
    async fn a_clip_that_never_answers_reports_too_large_and_stops() {
        // Every window is silent -- silent_all, not an enumerated list. See
        // FakeLive's doc comment: a list that misses one span the splitter
        // tries makes this test pass for the wrong reason.
        let (q, seen) = spawn(FakeLive {
            length: 16.0,
            notes: vec![(0.0, 60)],
            silent: vec![],
            silent_all: true,
            full_reply: None,
            malformed_length: false,
        })
        .await;

        let result = get_clip_notes(&q, 2, 1, FAST).await.unwrap();
        assert_eq!(result.missing_reason.as_deref(), Some("too_large"));
        assert!(result.notes.is_empty());
        assert!(
            *seen.lock().unwrap().get("/live/clip/get/notes").unwrap() <= MAX_WINDOWS,
            "the splitter must be bounded"
        );
    }

    #[tokio::test]
    async fn an_empty_clip_slot_surfaces_as_no_reply_rather_than_zero_notes() {
        // An empty slot makes `clip` None inside the handler, which raises
        // and answers nothing. "The clip has no notes" and "there is no
        // clip" are different facts and must not collapse.
        // No responder is spawned: nothing answers, which is exactly what
        // Live does here. `_live` only exists to own a port to aim at.
        let _live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, _live.local_port()).await.unwrap());
        let table = Arc::new(Mutex::new(RequestTable::new()));
        let q = LiveQuery::new(app, table);
        assert_eq!(get_clip_notes(&q, 9, 9, FAST).await, Err(QueryError::NoReply));
    }

    #[tokio::test]
    async fn notes_outside_the_requested_window_are_dropped_not_merged() {
        // IMPORTANT 1 (2026-08-16 whole-branch review): /live/clip/get/notes
        // is KeyArity::Args(2) -- the reply echoes only (track, clip), not
        // the window. A late reply meant for a cancelled window can resolve
        // a different, currently in-flight window's waiter. full_reply
        // stands in for that: every request gets back the SAME note set,
        // including one note (start = 12.0) outside the single window this
        // 8-beat clip actually asks for ([0, 8)).
        let (q, _seen) = spawn(FakeLive {
            length: 8.0,
            notes: vec![],
            silent: vec![],
            silent_all: false,
            full_reply: Some(vec![(0.0, 60), (4.0, 63), (12.0, 70)]),
            malformed_length: false,
        })
        .await;

        let result = get_clip_notes(&q, 2, 1, FAST).await.unwrap();
        assert_eq!(
            result.notes.iter().map(|n| n.pitch).collect::<Vec<_>>(),
            vec![60, 63],
            "the note at start=12.0, outside [0, 8), must be dropped rather than merged in"
        );
        assert_eq!(result.missing_reason, None);
    }

    #[tokio::test]
    async fn a_correct_reply_within_its_window_loses_no_notes() {
        // The normal path, unaffected by the window filter above: every note
        // the fake returns already falls inside the single window this clip
        // is fetched in, so none of them should be dropped.
        let (q, _seen) = spawn(FakeLive {
            length: 8.0,
            notes: vec![(0.0, 60), (4.0, 63), (7.9, 70)],
            silent: vec![],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
        })
        .await;

        let result = get_clip_notes(&q, 2, 1, FAST).await.unwrap();
        assert_eq!(
            result.notes.iter().map(|n| n.pitch).collect::<Vec<_>>(),
            vec![60, 63, 70]
        );
        assert_eq!(result.missing_reason, None);
    }

    #[tokio::test]
    async fn a_malformed_length_reply_is_reported_rather_than_treated_as_an_empty_clip() {
        // MINOR 10 (2026-08-16 whole-branch review): unwrap_or(0.0) on an
        // unreadable length reply used to fabricate a zero-span window,
        // returning {notes: [], missing_reason: null} -- "this clip is
        // empty", invented from a reply that could not be read.
        let (q, _seen) = spawn(FakeLive {
            length: 16.0,
            notes: vec![(0.0, 60)],
            silent: vec![],
            silent_all: false,
            full_reply: None,
            malformed_length: true,
        })
        .await;

        assert_eq!(get_clip_notes(&q, 2, 1, FAST).await, Err(QueryError::NoReply));
    }
}
