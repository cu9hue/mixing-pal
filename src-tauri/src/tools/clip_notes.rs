use crate::osc::budget::{max_notes_per_window, note_windows};
use crate::osc::query::{LiveQuery, QueryError};
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
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

/// Stamped on every window request and echoed back by
/// `mixingpal/clip_notes.py`'s `notes_window`, so no two window requests
/// ever share a `PendingKey`.
///
/// Process-wide rather than per-call, because per-call ordinals would
/// collide between two reads of the SAME clip running at once: both would
/// start at 0, and if one has halved a window and the other has not, the
/// two requests under one key cover different ranges. One relaxed
/// fetch_add rules that out for the life of the process.
///
/// It costs the request table's ability to JOIN two identical window
/// requests into one datagram. That dedup is worth little here -- two
/// concurrent reads of one clip are rare -- and correctness is worth more.
fn next_window_id() -> u32 {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// The note count gets this fraction of the caller's timeout, not all of it.
///
/// The count is a hint that sizes the first windows; its entire value is
/// avoiding ONE probe Live cannot answer, and such a probe costs exactly
/// one `timeout`. So spending a whole timeout to obtain the hint can never
/// pay, whatever the clip. A quarter leaves several Live ticks -- far more
/// than the one tick a script that knows the endpoint needs -- while
/// capping what a script that does NOT know it can cost.
///
/// This is the only thing standing between a stale install and a
/// regression: a version mismatch warns and keeps running (see
/// `Connection.tsx`'s `version_mismatch`), so an old script answering
/// nothing here is an ordinary state that must stay cheap.
const COUNT_HINT_TIMEOUT_DIVISOR: u32 = 4;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub pitch: i32,
    pub start: f64,
    pub duration: f64,
    pub velocity: f64,
    pub mute: bool,
}

/// The three addresses one note read uses.
///
/// Session and arrangement clips are different objects in Live and are
/// reached by different address families, but the reply shapes are identical
/// by construction (`mixingpal/clip_replies.py` builds both), so everything
/// below this line -- the decoder, the window halving, the retry budget --
/// is shared rather than copied. Copying it was the alternative, and this is
/// the most delicate code in the app.
#[derive(Debug, Clone, Copy)]
pub struct NoteAddresses {
    pub length: &'static str,
    pub num_notes: &'static str,
    pub notes_window: &'static str,
}

pub const SESSION_NOTES: NoteAddresses = NoteAddresses {
    length: "/live/clip/get/length",
    num_notes: "/live/clip/get/num_notes",
    notes_window: "/live/clip/get/notes_window",
};

pub const ARRANGEMENT_NOTES: NoteAddresses = NoteAddresses {
    length: "/live/arrangement_clip/get/length",
    num_notes: "/live/arrangement_clip/get/num_notes",
    notes_window: "/live/arrangement_clip/get/notes_window",
};

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClipNotes {
    pub notes: Vec<Note>,
    /// Set when at least one window never answered even at the floor. The
    /// notes returned are then a real but partial read, and saying so is the
    /// whole point: the model must not present part of a clip as all of it.
    pub missing_reason: Option<String>,
}

/// Turns the note count Live reported into an estimate worth windowing on.
///
/// Bounded, because the count arrives as an int on an unauthenticated
/// loopback UDP port and is otherwise used to size an allocation. A value
/// near `i32::MAX` would build roughly six million window boundaries and
/// as many queue entries -- tens of megabytes -- before `MAX_WINDOWS`
/// stopped the loop at sixteen requests. No window past that cap can ever
/// be sent, so none past it is worth building, and a clip genuinely larger
/// than the cap reads `too_large` either way.
///
/// A negative count is not a count. It falls back to 0, which is the
/// no-estimate path: one window over the whole clip, narrowed by
/// halve-and-retry.
fn usable_note_estimate(reported: i32) -> usize {
    if reported < 0 {
        return 0;
    }
    (reported as usize).min(MAX_WINDOWS * max_notes_per_window())
}

/// Splits one window into two that tile it exactly.
///
/// The consumer keeps a note when `start >= window_start && start <
/// window_start + span`, in f64 -- so the first half's computed end has to
/// be BIT-IDENTICAL to the second half's start, and the second half has to
/// end exactly where this window did. `(start, half)` plus `(start + half,
/// span - half)` does not: the f32 add in `start + half` rounds, and at a
/// count-sized start like 128/3 that is an overlap of 1.9e-6 in one window
/// (a note there comes back from both halves and is counted twice) and a
/// gap of the same order in the next (a note there is requested by neither
/// and disappears from a read that reports itself complete).
///
/// Both halves are therefore derived from ONE midpoint value and ONE end
/// value, with each span taken as a DIFFERENCE -- the same construction
/// `note_windows` uses for the initial tiling, and exact for the same
/// reason. `mid` need not be the true midpoint; it only has to be a single
/// f32 that both halves share. `end` recovers this window's own right
/// boundary exactly, because `span` was itself built as a difference of f32
/// boundaries, so the real sum `start + span` is an f32 and the add cannot
/// round. `mid - start` and `end - mid` are then exact by Sterbenz's
/// lemma: consecutive boundaries here are always within a factor of two.
///
/// Extracted from the retry loop so this property can be asserted directly
/// rather than inferred from the loop body.
fn halve(start: f32, span: f32) -> ((f32, f32), (f32, f32)) {
    let end = start + span;
    let mid = start + span / 2.0;
    ((start, mid - start), (mid, end - mid))
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

/// Reply shape: `(track_index, clip_index, window, *note_attributes)` --
/// see `mixingpal/clip_notes.py`'s `notes_window`, which echoes the
/// client's own window ordinal after the two indices and flattens each
/// note to `pitch, start_time, duration, velocity, mute`.
///
/// The `expect_window` check is defence in depth, NOT the thing that
/// catches a mis-attributed reply. The address is `KeyArity::Args(3)`, so
/// `RequestTable::resolve` keys on `(track, clip, window)`: a reply echoing
/// a different window matches no pending entry and is dropped there. Kept
/// for the same reason `decode_strings` keeps its `expect_start` check --
/// one integer compare, and it would still refuse such a reply if it ever
/// reached this decoder by another route.
pub fn decode_notes(args: &[OscType], expect_window: u32) -> Option<Vec<Note>> {
    match args.get(2)? {
        OscType::Int(w) if *w >= 0 && *w as u32 == expect_window => {}
        _ => return None,
    }
    let body = args.get(3..)?;
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
/// Every window of a round goes out before any of them is awaited, so a
/// clip that needs six windows costs one Live tick, not six:
/// `osc_server.process()` drains the whole socket per tick and answers
/// everything it finds. This is the same shape `get_device_chains` uses,
/// and it is only correct because `/live/clip/get/notes_window` echoes the
/// client's window ordinal -- upstream's `/live/clip/get/notes` echoes only
/// `(track, clip)`, so two windows of one clip were indistinguishable and
/// the second would `Joined` the first and never be sent.
///
/// A window Live could not answer is halved, and the halves go out in the
/// NEXT round, together with the halves of every other window that failed
/// alongside it. Rounds, not a serial descent: a round costs a tick
/// whatever its width.
///
/// One caveat on that tick. An oversized reply makes Live's `sendto` raise,
/// and the exception escapes into `process()`'s outer handler and aborts
/// the rest of that tick's drain -- so a round containing k unanswerable
/// windows costs up to k ticks, not one. That is the failure `num_notes`
/// exists to make rare, and the reason this is a round-based retry rather
/// than one giant fan-out.
pub async fn get_notes_at(
    q: Arc<LiveQuery>,
    addrs: NoteAddresses,
    track: i32,
    clip: i32,
    timeout: Duration,
) -> Result<ClipNotes, QueryError> {
    // An empty clip slot makes `clip` None inside the handler, which raises
    // and answers nothing -- so this failing is also how "there is no clip
    // here" reaches the caller, distinct from "the clip has no notes".
    // The length and the note count are independent, so they go out
    // together: `addrs.length` is `KeyArity::Args(2)` and `addrs.num_notes`
    // is a different address, so the two are trivially distinguishable and
    // AbletonOSC answers both inside the same ~100 ms tick
    // (`osc_server.process()` drains the whole socket per tick). Asking for
    // the count therefore costs no round trip at all.
    let (length_reply, count_reply) = tokio::join!(
        q.query(
            addrs.length,
            vec![OscType::Int(track), OscType::Int(clip)],
            timeout,
        ),
        q.query(
            addrs.num_notes,
            vec![OscType::Int(track), OscType::Int(clip)],
            timeout / COUNT_HINT_TIMEOUT_DIVISOR,
        )
    );
    // A reply that arrived but whose length value can't be read is not "the
    // clip is empty" -- unwrap_or(0.0) would turn an unreadable reply into a
    // fabricated zero-span window, which returns {notes: [], missing_reason:
    // null}, i.e. an invented "this clip is empty" the reply never said.
    let length = length_reply?.get(2).and_then(as_f64).ok_or(QueryError::NoReply)? as f32;

    // The count is a HINT, not data: it only decides how wide the first
    // windows are. Every way it can be absent -- a Remote Script too old to
    // know the endpoint, a dropped datagram, a reply this decoder refuses
    // -- falls back to 0, one window over the whole clip narrowed by
    // halve-and-retry. A wrong count costs round trips, never correctness.
    let est_notes = count_reply
        .ok()
        .and_then(|r| r.get(2).and_then(as_i32))
        .map(usable_note_estimate)
        .unwrap_or(0);

    let mut pending: Vec<(f32, f32)> = note_windows(length, est_notes);
    let mut notes: Vec<Note> = Vec::new();
    let mut missing_reason = None;
    let mut windows_used = 0usize;

    while !pending.is_empty() {
        let room = MAX_WINDOWS.saturating_sub(windows_used);
        if room == 0 {
            missing_reason = Some("too_large".to_string());
            break;
        }
        if pending.len() > room {
            // The windows dropped here were never asked for, so they are a
            // truncation rather than a failure -- but the read is partial
            // either way and has to say so.
            pending.truncate(room);
            missing_reason = Some("too_large".to_string());
        }
        windows_used += pending.len();

        // Spawn every window in this round FIRST so they are all on the
        // wire, then await them in order. Awaiting in order serialises
        // nothing -- the requests already went out -- and it keeps each
        // result paired with the window that asked for it.
        let inflight: Vec<_> = pending
            .iter()
            .map(|&(start, span)| {
                let q = q.clone();
                // The ordinal leads the request because `RequestTable` keys
                // on the first n args of the request and of the reply
                // alike, so the key args have to come first in both.
                let window = next_window_id();
                let args = vec![
                    OscType::Int(track),
                    OscType::Int(clip),
                    OscType::Int(window as i32),
                    OscType::Int(PITCH_START),
                    OscType::Int(PITCH_SPAN),
                    OscType::Float(start),
                    OscType::Float(span),
                ];
                tokio::spawn(async move {
                    (window, q.query(addrs.notes_window, args, timeout).await)
                })
            })
            .collect();

        let mut next: Vec<(f32, f32)> = Vec::new();
        for (&(start, span), handle) in pending.iter().zip(inflight) {
            match handle.await {
                Ok((window, Ok(reply))) => match decode_notes(&reply, window) {
                    // Live's ranged query form is start-time keyed, so a
                    // correct reply only ever contains notes inside
                    // [start, start + span). This is a no-op on a correct
                    // reply; it is kept because a reply that somehow
                    // carried out-of-range notes must not merge them in.
                    Some(mut decoded) => {
                        let window_start = start as f64;
                        let window_end = window_start + span as f64;
                        decoded.retain(|n| n.start >= window_start && n.start < window_end);
                        notes.append(&mut decoded)
                    }
                    None => missing_reason = Some("malformed_reply".to_string()),
                },
                // Halve and retry: the reply may simply have been too large
                // for one datagram. `halve` is what makes the two pieces
                // tile [start, start + span) exactly -- see its doc
                // comment; the obvious arithmetic does not.
                Ok((_, Err(QueryError::NoReply))) if span > MIN_WINDOW_BEATS => {
                    let (first, second) = halve(start, span);
                    next.push(first);
                    next.push(second);
                }
                Ok((_, Err(QueryError::NoReply))) => {
                    missing_reason = Some("too_large".to_string())
                }
                Ok((_, Err(e))) => return Err(e),
                // A panicked window task is one window's worth of missing
                // notes, not a failed read of the clip.
                Err(_) => missing_reason = Some("window_task_failed".to_string()),
            }
        }
        pending = next;
    }

    notes.sort_by(|a, b| {
        a.start
            .partial_cmp(&b.start)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.pitch.cmp(&b.pitch))
    });
    Ok(ClipNotes { notes, missing_reason })
}

/// Session-view clip notes. The shape the app has always had; the address
/// family is now explicit so the arrangement read can share everything else.
pub async fn get_clip_notes(
    q: Arc<LiveQuery>,
    track: i32,
    clip: i32,
    timeout: Duration,
) -> Result<ClipNotes, QueryError> {
    get_notes_at(q, SESSION_NOTES, track, clip, timeout).await
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
    fn decode_notes_refuses_a_reply_that_echoes_a_different_window() {
        // Defence in depth, not the thing that catches a mis-attributed
        // reply -- `/live/clip/get/notes_window` is `KeyArity::Args(3)`, so
        // a reply echoing another window matches no pending entry and dies
        // in `RequestTable::resolve`. Exactly the role `decode_strings`'s
        // `expect_start` check plays for device parameters, and kept for
        // the same reason: it costs one integer compare and would still
        // refuse such a reply if it ever arrived by another route.
        let mut args = vec![OscType::Int(2), OscType::Int(1), OscType::Int(7)];
        args.extend(note_values(60, 0.0));

        assert!(decode_notes(&args, 7).is_some(), "its own window decodes");
        assert!(decode_notes(&args, 8).is_none(), "another window's does not");
    }

    #[test]
    fn decode_notes_reads_each_note_past_the_three_echoed_key_args() {
        // `notes_window` echoes (track_index, clip_index, window) and then
        // flattens pitch, start_time, duration, velocity, mute per note.
        let mut args = vec![OscType::Int(2), OscType::Int(1), OscType::Int(0)];
        args.extend(note_values(60, 0.0));
        args.extend(note_values(64, 1.0));

        let notes = decode_notes(&args, 0).unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0], Note { pitch: 60, start: 0.0, duration: 0.5, velocity: 100.0, mute: false });
        assert_eq!(notes[1].pitch, 64);
        assert_eq!(notes[1].start, 1.0);
    }

    #[test]
    fn decode_notes_fails_closed_when_the_body_is_not_a_multiple_of_five() {
        // A misaligned decode would invent notes at wrong pitches -- exactly
        // the plausible-wrong-data this codebase refuses to produce.
        let mut args = vec![OscType::Int(2), OscType::Int(1), OscType::Int(0)];
        args.extend(note_values(60, 0.0));
        args.pop();
        assert!(decode_notes(&args, 0).is_none());
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
        /// Buffers every window request and answers none of them until it
        /// has seen this many. A serial pager can never satisfy it, so it
        /// is how a test asserts the windows really do go out together.
        hold_notes_until: Option<usize>,
        /// Whether this stand-in knows `/live/clip/get/num_notes` at all.
        /// False is a Remote Script installed before the endpoint existed,
        /// which the version handshake warns about but does not refuse to
        /// run against -- see `Connection.tsx`'s `version_mismatch`.
        answers_num_notes: bool,
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
            let mut held: Vec<Vec<OscType>> = Vec::new();
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
                    "/live/clip/get/num_notes" if fake.answers_num_notes => {
                        let _ = live
                            .send_to(
                                app_port,
                                "/live/clip/get/num_notes",
                                vec![
                                    req.args[0].clone(),
                                    req.args[1].clone(),
                                    OscType::Int(fake.notes.len() as i32),
                                ],
                            )
                            .await;
                    }
                    "/live/clip/get/notes_window" => {
                        let (start, span) = (f(5), f(6));
                        let silent = fake.silent_all
                            || fake.silent.iter().any(|(s, p)| {
                                (s - start).abs() < 1e-3 && (p - span).abs() < 1e-3
                            });
                        if silent {
                            continue; // the reply Live could not send
                        }
                        // (track, clip, window) echoed back, ordinal and all.
                        let mut reply = vec![
                            req.args[0].clone(),
                            req.args[1].clone(),
                            req.args[2].clone(),
                        ];
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
                        match fake.hold_notes_until {
                            Some(n) => {
                                held.push(reply);
                                if held.len() < n {
                                    continue;
                                }
                                for reply in held.drain(..) {
                                    let _ = live
                                        .send_to(
                                            app_port,
                                            "/live/clip/get/notes_window",
                                            reply,
                                        )
                                        .await;
                                }
                            }
                            None => {
                                let _ = live
                                    .send_to(app_port, "/live/clip/get/notes_window", reply)
                                    .await;
                            }
                        }
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();
        assert_eq!(result.notes.len(), 3);
        assert_eq!(result.missing_reason, None);
        assert_eq!(
            seen.lock().unwrap().get("/live/clip/get/notes_window"),
            Some(&1),
            "a clip that fits must cost exactly one round trip"
        );
    }

    #[test]
    fn a_reported_note_count_is_clamped_to_what_the_window_budget_can_ever_use() {
        // The count arrives as an int on an unauthenticated loopback UDP
        // port. Used raw, a value near i32::MAX makes `note_windows`
        // allocate roughly six million boundaries and the queue as many
        // windows -- tens of megabytes -- before `MAX_WINDOWS` stops the
        // loop at sixteen requests. Nothing past that cap can ever be sent,
        // so nothing past it is worth building.
        let cap = MAX_WINDOWS * max_notes_per_window();

        assert_eq!(usable_note_estimate(i32::MAX), cap, "a hostile count is bounded");
        assert_eq!(usable_note_estimate(cap as i32 + 1), cap);
        assert_eq!(note_windows(128.0, usable_note_estimate(i32::MAX)).len(), MAX_WINDOWS);

        // A count the budget CAN use is passed through untouched -- the
        // clamp must not quietly under-window an ordinary dense clip.
        assert_eq!(usable_note_estimate(2048), 2048);
        assert_eq!(usable_note_estimate(0), 0);

        // Negative is not a count. Falling back to 0 is the no-estimate
        // path, which is exactly what this function did before the endpoint
        // existed.
        assert_eq!(usable_note_estimate(-1), 0);
    }

    #[test]
    fn halving_keeps_the_boundary_the_consumer_compares_on_bit_exact() {
        // `get_clip_notes` keeps a note when
        // `start >= window_start && start < window_start + span`, in f64.
        // So the first half's computed END must be bit-identical to the
        // second half's start, and the second half must end exactly where
        // the parent did -- the same requirement `note_windows` already
        // meets for the initial tiling, carried into the retry path.
        //
        // It held for free while every window descended from `(0, length)`
        // by halving: those starts are dyadic and `start + span / 2` is
        // exact. Count-sized windows start at values like 128/3, where the
        // f32 add rounds. At 128/3 the first split OVERLAPS by 1.9e-6 (a
        // note there is returned by both halves and counted twice) and the
        // next one GAPS by the same order (a note there is requested by
        // neither half and vanishes from a read that reports itself
        // complete).
        //
        // Walks the real descent, not a hand-picked pair: every window
        // `note_windows` produces, halved down to the floor.
        for est in [719usize, 1000, 2049, 5000] {
            let mut queue: Vec<(f32, f32)> = note_windows(128.0, est);
            let mut depth = 0;
            while let Some((start, span)) = queue.pop() {
                let ((a_start, a_span), (b_start, b_span)) = halve(start, span);

                assert_eq!(
                    a_start as f64 + a_span as f64,
                    b_start as f64,
                    "gap or overlap between halves of ({start}, {span}), est {est}"
                );
                assert_eq!(
                    b_start as f64 + b_span as f64,
                    start as f64 + span as f64,
                    "the second half must end exactly where ({start}, {span}) did, est {est}"
                );
                assert!(a_span > 0.0 && b_span > 0.0, "neither half may be empty");

                depth += 1;
                if depth < 64 && a_span > MIN_WINDOW_BEATS {
                    queue.push((a_start, a_span));
                    queue.push((b_start, b_span));
                }
            }
        }
    }

    #[tokio::test]
    async fn every_window_of_a_clip_is_in_flight_before_any_of_them_is_awaited() {
        // `/live/clip/get/notes_window` echoes the window ordinal, so two
        // windows of one clip are distinct keys and the whole clip fits in
        // one Live tick. Upstream's `/live/clip/get/notes` echoes only
        // (track, clip), which forces them serial: the second would
        // `Joined` the first and never be sent.
        //
        // The fake answers nothing until BOTH windows have arrived, which a
        // serial pager can never satisfy -- it would time out on the first
        // and start halving, which shows up as more than two requests and a
        // partial read.
        let notes: Vec<(f32, i32)> =
            (0..400).map(|i| (i as f32 * 16.0 / 400.0, 36 + (i % 60) as i32)).collect();
        let (q, seen) = spawn(FakeLive {
            length: 16.0,
            notes,
            silent: vec![],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
            answers_num_notes: true,
            hold_notes_until: Some(2),
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();

        assert_eq!(result.notes.len(), 400);
        assert_eq!(result.missing_reason, None);
        assert_eq!(
            seen.lock().unwrap().get("/live/clip/get/notes_window"),
            Some(&2),
            "exactly the two windows the count called for, both in flight at once"
        );
    }

    #[tokio::test]
    async fn a_dense_clip_is_windowed_from_the_note_count_and_never_probes_the_whole_clip() {
        // The measured failure this endpoint exists to remove. Without a
        // note count, `note_windows(length, 0)` returns ONE window covering
        // the whole clip, whatever the density -- so the first request for
        // any clip past 358 notes is one Live cannot answer, and the client
        // learns that only by waiting out the full timeout before it starts
        // halving. Here the whole-clip window is the one the fake refuses,
        // so a run that still probes it costs a timeout and an extra round
        // trip, and a run that sizes its windows from the count costs
        // neither.
        //
        // 400 notes over 16 beats needs ceil(400 / 358) = 2 windows.
        let notes: Vec<(f32, i32)> =
            (0..400).map(|i| (i as f32 * 16.0 / 400.0, 36 + (i % 60) as i32)).collect();
        let (q, seen) = spawn(FakeLive {
            length: 16.0,
            notes: notes.clone(),
            silent: vec![(0.0, 16.0)],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();

        assert_eq!(result.notes.len(), 400, "every note, reassembled from both windows");
        assert_eq!(result.missing_reason, None);
        assert_eq!(
            seen.lock().unwrap().get("/live/clip/get/notes_window"),
            Some(&2),
            "two windows sized from the count -- never the whole-clip probe that \
             cannot be answered"
        );
    }

    #[tokio::test]
    async fn a_script_too_old_to_report_the_note_count_does_not_wait_out_the_query_timeout() {
        // A version mismatch WARNS and keeps running (see `Connection.tsx`'s
        // `version_mismatch`), so a producer who has not reinstalled yet is
        // an ordinary state, not an error. The note count is optional, and
        // its whole value is saving ONE wasted probe -- which costs exactly
        // one timeout. So waiting a whole timeout to obtain it can never
        // pay, and this asserts the wait is a fraction of one.
        //
        // Without that bound, an old script would make every clip read pay
        // the full timeout before it even starts.
        let (q, _seen) = spawn(FakeLive {
            length: 16.0,
            notes: vec![(0.0, 60), (4.0, 63), (8.0, 67)],
            silent: vec![],
            silent_all: false,
            full_reply: None,
            malformed_length: false,
            answers_num_notes: false,
            hold_notes_until: None,
        })
        .await;

        let timeout = Duration::from_millis(400);
        let started = std::time::Instant::now();
        let result = get_clip_notes(q, 2, 1, timeout).await.unwrap();
        let elapsed = started.elapsed();

        assert_eq!(result.notes.len(), 3, "the clip still reads, count or no count");
        assert_eq!(result.missing_reason, None);
        assert!(
            elapsed < timeout / 2,
            "an absent count must cost a fraction of the timeout, not all of it; \
             took {elapsed:?} of a {timeout:?} budget"
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();
        assert_eq!(result.missing_reason.as_deref(), Some("too_large"));
        assert!(result.notes.is_empty());
        assert!(
            *seen.lock().unwrap().get("/live/clip/get/notes_window").unwrap() <= MAX_WINDOWS,
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
        let q = Arc::new(LiveQuery::new(app, table));
        assert_eq!(get_clip_notes(q, 9, 9, FAST).await, Err(QueryError::NoReply));
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        let result = get_clip_notes(q, 2, 1, FAST).await.unwrap();
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
            answers_num_notes: true,
            hold_notes_until: None,
        })
        .await;

        assert_eq!(get_clip_notes(q, 2, 1, FAST).await, Err(QueryError::NoReply));
    }
}
