mod deltas;
mod osc;

use deltas::{Coalescer, Delta};
use osc::budget::track_chunks;
use osc::pollers::{PollKind, PollSchedule};
use osc::requests::{Registration, RequestTable};
use osc::socket::OscSocket;
use osc::subs::SINGLETON_SUBSCRIPTIONS;
use rosc::OscType;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Property names requested per `track_data` chunk. Kept next to the chunk
/// builder because `track_chunks`' byte-budget math needs the count to
/// match exactly what actually goes on the wire.
const TRACK_DATA_PROPERTIES: [&str; 3] = ["track.name", "track.mute", "track.solo"];

/// How often the poll loop unconditionally resends `SINGLETON_SUBSCRIPTIONS`,
/// whether or not any traffic has arrived in between. Not silence-gated:
/// loading a different project in Live swaps the `Song` object every polled
/// getter (`track_data`, `mixer_data`, `num_tracks`, meters) resolves
/// through, so those keep working and traffic keeps flowing, but the old
/// song/view listeners stay registered on the *previous* `Song` object and
/// go stale silently -- absence of traffic is therefore not a reliable
/// signal that the subscriptions died. A fixed interval heals that case,
/// plus "Live restarted", "Live hadn't started yet when we first
/// subscribed", and "a subscribe datagram got dropped", all with one
/// mechanism.
const SUBSCRIPTION_RESEND_INTERVAL: Duration = Duration::from_secs(10);

/// Cached as replies to `/live/song/get/{num_tracks,num_scenes}` arrive
/// through the normal receive-loop observation path. `track_chunks` needs
/// the real counts, and parsing a `track_data` reply requires them anyway
/// since its clip segments are positional -- so chunked polling is skipped
/// until both are known rather than guessed.
#[derive(Default)]
struct TrackCounts {
    num_tracks: Option<usize>,
    num_scenes: Option<usize>,
}

/// Returns every retained value (see `Coalescer::snapshot`) so a webview
/// that just mounted -- or just reloaded -- can catch up on state that
/// already arrived and was drained by the emit loop before its listener
/// existed. This is what makes a reload "cost a resnapshot and nothing
/// more": the subscriptions live in Rust and never resend on their own, so
/// without this the frontend would see only values that change *after* it
/// starts listening, and a set left at its defaults would show nothing.
#[tauri::command]
fn snapshot(state: tauri::State<Arc<Mutex<Coalescer>>>) -> Vec<Delta> {
    match state.lock() {
        Ok(c) => c.snapshot(),
        Err(_) => Vec::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![snapshot])
        .setup(|app| {
            // Set up regardless of whether the OSC socket binds -- a dead
            // socket shouldn't hide the whole window.
            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(true)?;

            let handle = app.handle().clone();
            let coalescer = Arc::new(Mutex::new(Coalescer::new()));
            // Managed state so the `snapshot` command can reach the same
            // coalescer the receive loop feeds.
            app.manage(coalescer.clone());
            let counts = Arc::new(Mutex::new(TrackCounts::default()));
            // Shared with the receive loop so a reply can actually clear
            // its own single-flight slot instead of every address's rate
            // being an accidental function of `expire`'s timeout. See the
            // resolve() call in the receive loop below.
            let table = Arc::new(Mutex::new(RequestTable::new()));

            // Bound synchronously, via the background tokio runtime Tauri
            // already manages, so the same Arc<OscSocket> can be handed to
            // both the receive loop and the poll loop from the start. This
            // call runs on the platform event-loop thread (setup's caller),
            // not inside that runtime's own worker pool, so blocking here
            // is safe -- it is not a nested block_on.
            let socket = match tauri::async_runtime::block_on(OscSocket::bind()) {
                Ok(s) => Arc::new(s),
                Err(e) => {
                    eprintln!("failed to bind OSC socket: {e}");
                    return Ok(());
                }
            };

            // Sole reader: this loop is the only caller of `recv()` on
            // this socket for the lifetime of the app. Do not add a second
            // `recv()` caller — see `OscSocket::recv`'s doc comment for why
            // that hangs indefinitely. The poll loop below only ever calls
            // `send()`, which is safe from multiple `Arc` holders.
            let recv_socket = socket.clone();
            let recv_coalescer = coalescer.clone();
            let recv_counts = counts.clone();
            let recv_table = table.clone();
            tauri::async_runtime::spawn(async move {
                for addr in SINGLETON_SUBSCRIPTIONS {
                    let _ = recv_socket.send(addr, vec![]).await;
                }
                loop {
                    match recv_socket.recv().await {
                        Ok(msg) => {
                            if let Ok(mut c) = recv_coalescer.lock() {
                                c.observe(&msg);
                            }
                            // Every inbound packet is an observation first
                            // and a promise resolution second (see
                            // `RequestTable::resolve`'s doc comment).
                            // Resolving here -- rather than leaving a
                            // single-flight slot to clear only via
                            // `expire`'s 2s timeout -- is what makes the
                            // rates in `PollKind::interval` the rates that
                            // actually go out on the wire.
                            if let Ok(mut t) = recv_table.lock() {
                                t.resolve(&msg);
                            }
                            // The poll loop needs the real track and scene
                            // counts to chunk `track_data` correctly. Cache
                            // them here, through the same observation path
                            // everything else already flows through,
                            // instead of adding a second call site that
                            // waits on its own reply.
                            match (msg.addr.as_str(), msg.args.first()) {
                                ("/live/song/get/num_tracks", Some(OscType::Int(n))) => {
                                    if let Ok(mut c) = recv_counts.lock() {
                                        c.num_tracks = Some((*n).max(0) as usize);
                                    }
                                }
                                ("/live/song/get/num_scenes", Some(OscType::Int(n))) => {
                                    if let Ok(mut c) = recv_counts.lock() {
                                        c.num_scenes = Some((*n).max(0) as usize);
                                    }
                                }
                                _ => {}
                            }
                        }
                        Err(e) => eprintln!("osc recv error: {e}"),
                    }
                }
            });

            // Emit loop: one batch every 250 ms.
            tauri::async_runtime::spawn(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                loop {
                    ticker.tick().await;
                    let batch = match coalescer.lock() {
                        Ok(mut c) => c.drain(),
                        Err(_) => continue,
                    };
                    if !batch.is_empty() {
                        let _ = handle.emit("live://deltas", batch);
                    }
                }
            });

            // Poll loop: drives every indexed address that cannot be safely
            // subscribed (see `SINGLETON_SUBSCRIPTIONS`'s doc comment) by
            // asking for it on a fixed schedule instead.
            let poll_socket = socket.clone();
            let poll_counts = counts.clone();
            let poll_table = table.clone();
            tauri::async_runtime::spawn(async move {
                let mut schedule = PollSchedule::new(Instant::now());
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                let mut track_data_queue: VecDeque<(usize, usize)> = VecDeque::new();
                // The (num_tracks, num_scenes) the queue above was built
                // against, so a topology change can invalidate a
                // mid-sweep queue instead of finishing a sweep that's
                // already stale.
                let mut queue_built_for: Option<(usize, usize)> = None;
                let mut faders_pending = false;

                // `PollSchedule::new` seeds every kind's last-run to `now`,
                // so nothing would be due for a full interval — up to 2s of
                // empty state right after connect. Force one immediate pass
                // over every kind so the first snapshot starts filling in
                // right away; `schedule.mark` below then puts each kind
                // back on its normal cadence.
                let start = Instant::now();
                // The receive loop already sent SINGLETON_SUBSCRIPTIONS
                // once before this loop starts; the periodic resend below
                // starts counting from here.
                let mut last_resubscribe = start;
                for kind in PollKind::all() {
                    poll_kind(
                        kind,
                        start,
                        &poll_table,
                        &poll_socket,
                        &poll_counts,
                        &mut track_data_queue,
                        &mut queue_built_for,
                        &mut faders_pending,
                    )
                    .await;
                    schedule.mark(kind, start);
                }

                loop {
                    ticker.tick().await;
                    let now = Instant::now();

                    // Free slots BEFORE anything else can claim them this
                    // tick, so a request whose window just elapsed is
                    // retryable on this very tick rather than the next one.
                    match poll_table.lock() {
                        Ok(mut t) => {
                            t.expire(now, Duration::from_secs(2));
                        }
                        Err(_) => {
                            eprintln!(
                                "osc request table lock poisoned; cannot expire stale requests"
                            );
                        }
                    }

                    // Unconditional, not silence-gated -- see
                    // SUBSCRIPTION_RESEND_INTERVAL's doc comment for why a
                    // set load in Live leaves subscriptions dead while
                    // traffic (track_data, mixer_data, meters) keeps
                    // flowing, so absence of traffic can't be trusted as
                    // the signal to resubscribe on.
                    maybe_resubscribe(&poll_socket, now, &mut last_resubscribe).await;

                    // Retry work a previous tick left Deferred (a
                    // single-flight address still had another request
                    // outstanding) before considering what's newly due.
                    // Dropping this, the way `if let Registration::New(_)
                    // = ...` alone would, silently loses track_data chunks
                    // 2..n and any deferred mixer_data poll forever.
                    drain_track_data_queue(&poll_table, &poll_socket, &mut track_data_queue, now)
                        .await;
                    if faders_pending {
                        try_faders(&poll_table, &poll_socket, now, &mut faders_pending).await;
                    }

                    for kind in schedule.due(now) {
                        poll_kind(
                            kind,
                            now,
                            &poll_table,
                            &poll_socket,
                            &poll_counts,
                            &mut track_data_queue,
                            &mut queue_built_for,
                            &mut faders_pending,
                        )
                        .await;
                        schedule.mark(kind, now);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Resends every `SINGLETON_SUBSCRIPTIONS` address once
/// `SUBSCRIPTION_RESEND_INTERVAL` has elapsed since the last resend, and
/// advances `last_resubscribe`. Unconditional: see
/// `SUBSCRIPTION_RESEND_INTERVAL`'s doc comment for why gating this on
/// recent silence would miss the case where Live loads a different project
/// and keeps producing traffic on every polled address while the
/// subscriptions themselves are dead.
async fn maybe_resubscribe(poll_socket: &OscSocket, now: Instant, last_resubscribe: &mut Instant) {
    if now.duration_since(*last_resubscribe) < SUBSCRIPTION_RESEND_INTERVAL {
        return;
    }
    for addr in SINGLETON_SUBSCRIPTIONS {
        let _ = poll_socket.send(addr, vec![]).await;
    }
    *last_resubscribe = now;
}

/// Executes one `PollKind`'s share of work for a single pass, whether that
/// pass is the forced immediate one at connect or a normal scheduled tick.
#[allow(clippy::too_many_arguments)]
async fn poll_kind(
    kind: PollKind,
    now: Instant,
    table: &Mutex<RequestTable>,
    poll_socket: &OscSocket,
    counts: &Mutex<TrackCounts>,
    track_data_queue: &mut VecDeque<(usize, usize)>,
    queue_built_for: &mut Option<(usize, usize)>,
    faders_pending: &mut bool,
) {
    match kind {
        PollKind::TrackState => {
            // Both keyless (`KeyArity::None`), so these never Defer — they
            // settle as New or Joined every time.
            for addr in ["/live/song/get/num_tracks", "/live/song/get/num_scenes"] {
                register_and_send(table, poll_socket, now, addr, vec![]).await;
            }

            let (num_tracks, num_scenes) = match counts.lock() {
                Ok(c) => (c.num_tracks, c.num_scenes),
                Err(_) => (None, None),
            };
            // track_chunks needs the real counts; skip the chunked poll
            // until both are known. Self-correcting: the requests above
            // populate them within a poll or two of connecting.
            if let (Some(num_tracks), Some(num_scenes)) = (num_tracks, num_scenes) {
                let current = (num_tracks, num_scenes);
                if *queue_built_for != Some(current) {
                    // Either the first time both counts are known, or the
                    // counts changed since the queue was built (a track
                    // was added/removed mid-sweep). Either way, whatever is
                    // still queued was built against stale counts and
                    // would request wrong ranges, so restart the sweep
                    // instead of draining the stale one out first.
                    track_data_queue.clear();
                    track_data_queue.extend(track_chunks(
                        num_tracks,
                        num_scenes,
                        TRACK_DATA_PROPERTIES.len(),
                    ));
                    *queue_built_for = Some(current);
                }
                drain_track_data_queue(table, poll_socket, track_data_queue, now).await;
            }
        }
        PollKind::Faders => {
            *faders_pending = true;
            try_faders(table, poll_socket, now, faders_pending).await;
        }
        PollKind::Selection => {
            for addr in [
                "/live/view/get/selected_clip",
                "/live/view/get/selected_device",
            ] {
                register_and_send(table, poll_socket, now, addr, vec![]).await;
            }
        }
        PollKind::Meters => {
            register_and_send(
                table,
                poll_socket,
                now,
                "/live/master/get/output_meter_level",
                vec![],
            )
            .await;
        }
        PollKind::FocusedNotes => {
            // Left unwired: a later plan owns the focused-clip digest and
            // calls `NoteTracker` directly.
        }
    }
}

/// Registers `addr` and sends immediately if it's newly registered. Only
/// meant for `KeyArity::None` addresses: `Joined` is fine to drop (an
/// equivalent request is already in flight) and `Deferred` is structurally
/// unreachable for a keyless address. On a poisoned lock, logs and skips
/// rather than fabricating a `Registration` value for a failure this table
/// was never asked to classify.
async fn register_and_send(
    table: &Mutex<RequestTable>,
    poll_socket: &OscSocket,
    now: Instant,
    addr: &str,
    args: Vec<OscType>,
) {
    let registration = match table.lock() {
        Ok(mut t) => t.register(now, addr, &args),
        Err(_) => {
            eprintln!("osc request table lock poisoned; skipping {addr} this tick");
            return;
        }
    };
    if let Registration::New(_) = registration {
        let _ = poll_socket.send(addr, args).await;
    }
}

/// Drains as much of the `track_data` chunk queue as the single-flight
/// address currently allows. `track_data` is `KeyArity::Unkeyed`, so at
/// most one chunk can be outstanding at a time; the first `Deferred` means
/// every later chunk would defer too, so this stops there rather than
/// burning cycles re-registering chunks already known to be blocked.
async fn drain_track_data_queue(
    table: &Mutex<RequestTable>,
    poll_socket: &OscSocket,
    queue: &mut VecDeque<(usize, usize)>,
    now: Instant,
) {
    while let Some(&(min, max)) = queue.front() {
        let mut args = vec![OscType::Int(min as i32), OscType::Int(max as i32)];
        args.extend(
            TRACK_DATA_PROPERTIES
                .iter()
                .map(|p| OscType::String((*p).to_string())),
        );
        let registration = match table.lock() {
            Ok(mut t) => t.register(now, "/live/song/get/track_data", &args),
            Err(_) => {
                eprintln!(
                    "osc request table lock poisoned; skipping track_data chunk this tick"
                );
                break;
            }
        };
        match registration {
            Registration::New(_) => {
                let _ = poll_socket.send("/live/song/get/track_data", args).await;
                queue.pop_front();
            }
            // track_data is KeyArity::Unkeyed, so Joined is structurally
            // unreachable here (the per-address outstanding flag would
            // already have returned Deferred first). If that invariant
            // ever breaks anyway, treating it as a reason to retry rather
            // than pop keeps the worst case a redundant send instead of a
            // silently dropped chunk.
            Registration::Joined(_) | Registration::Deferred => break,
        }
    }
}

async fn try_faders(
    table: &Mutex<RequestTable>,
    poll_socket: &OscSocket,
    now: Instant,
    pending: &mut bool,
) {
    let addr = "/live/track/get/mixer_data";
    let args = vec![OscType::Int(0), OscType::Int(-1)];
    let registration = match table.lock() {
        Ok(mut t) => t.register(now, addr, &args),
        Err(_) => {
            eprintln!("osc request table lock poisoned; skipping mixer_data this tick");
            return; // leave `pending` set so a later tick retries
        }
    };
    match registration {
        Registration::New(_) => {
            let _ = poll_socket.send(addr, args).await;
            *pending = false;
        }
        // mixer_data is also KeyArity::Unkeyed, so Joined is equally
        // unreachable here -- same reasoning as drain_track_data_queue:
        // retry rather than treat it as done.
        Registration::Joined(_) | Registration::Deferred => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::OscMessage;

    async fn recv_message(listener: &OscSocket) -> OscMessage {
        listener.recv().await.expect("expected a datagram")
    }

    #[tokio::test]
    async fn resubscribe_interval_resends_every_singleton_subscription() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let start = Instant::now();
        let mut last_resubscribe = start;

        // Before the interval elapses, nothing is sent.
        maybe_resubscribe(&poll_socket, start, &mut last_resubscribe).await;
        let nothing_sent =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(
            nothing_sent.is_err(),
            "resubscribe must not fire before the interval elapses"
        );
        assert_eq!(last_resubscribe, start);

        // Once the interval elapses, every SINGLETON_SUBSCRIPTIONS address
        // goes out again -- unconditionally, regardless of whether any
        // traffic arrived in between. That's the property that heals a
        // Live project switch, where polled addresses keep replying but
        // the song/view listeners are dead.
        let later = start + SUBSCRIPTION_RESEND_INTERVAL;
        maybe_resubscribe(&poll_socket, later, &mut last_resubscribe).await;
        for expected in SINGLETON_SUBSCRIPTIONS {
            let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
                .await
                .expect("expected every SINGLETON_SUBSCRIPTIONS address to be resent");
            assert_eq!(&msg.addr, expected);
        }
        assert_eq!(last_resubscribe, later);
    }

    #[tokio::test]
    async fn track_data_queue_retries_deferred_chunks_across_ticks() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let mut queue: VecDeque<(usize, usize)> = VecDeque::from([(0, 1), (1, 2), (2, 3)]);
        let start = Instant::now();

        // First pass: track_data is single-flight per address, so only
        // chunk 1 goes out. Chunks 2 and 3 must stay queued, not be
        // dropped, per the brief's carried-forward Deferred-retry fix.
        drain_track_data_queue(&table, &poll_socket, &mut queue, start).await;

        let msg = recv_message(&listener).await;
        assert_eq!(msg.addr, "/live/song/get/track_data");
        assert_eq!(msg.args[0], OscType::Int(0));
        assert_eq!(msg.args[1], OscType::Int(1));
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.front(), Some(&(1, 2)));

        // A second pass before the slot frees must not send anything new.
        drain_track_data_queue(&table, &poll_socket, &mut queue, start).await;
        assert_eq!(queue.len(), 2);
        let nothing_sent =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(
            nothing_sent.is_err(),
            "no chunk should be sent while chunk 1 is still in flight"
        );

        // Once the slot expires, the next pass sends chunk 2.
        let later = start + Duration::from_secs(3);
        {
            let mut t = table.lock().unwrap();
            t.expire(later, Duration::from_secs(2));
        }
        drain_track_data_queue(&table, &poll_socket, &mut queue, later).await;
        let msg2 = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect("expected chunk 2 to be sent once the slot expired");
        assert_eq!(msg2.args[0], OscType::Int(1));
        assert_eq!(msg2.args[1], OscType::Int(2));
        assert_eq!(queue.len(), 1);
    }

    #[tokio::test]
    async fn faders_pending_retries_a_deferred_mixer_data_poll() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let start = Instant::now();

        // Occupy mixer_data's single-flight slot directly, as if a
        // previous poll had already claimed it.
        {
            let mut t = table.lock().unwrap();
            let args = [OscType::Int(0), OscType::Int(-1)];
            t.register(start, "/live/track/get/mixer_data", &args);
        }

        let mut pending = true;
        try_faders(&table, &poll_socket, start, &mut pending).await;
        assert!(
            pending,
            "mixer_data is already in flight; the retry must stay pending, not be dropped"
        );
        let nothing_sent =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(
            nothing_sent.is_err(),
            "no poll should be sent while one is already in flight"
        );

        // Once the slot expires, the retry succeeds.
        let later = start + Duration::from_secs(3);
        {
            let mut t = table.lock().unwrap();
            t.expire(later, Duration::from_secs(2));
        }
        try_faders(&table, &poll_socket, later, &mut pending).await;
        assert!(!pending);
        let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect("expected mixer_data to be sent once the slot expired");
        assert_eq!(msg.addr, "/live/track/get/mixer_data");
    }
}
