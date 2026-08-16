mod deltas;
mod osc;

use deltas::Coalescer;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Set up regardless of whether the OSC socket binds -- a dead
            // socket shouldn't hide the whole window.
            let window = app.get_webview_window("main").unwrap();
            window.set_always_on_top(true)?;

            let handle = app.handle().clone();
            let coalescer = Arc::new(Mutex::new(Coalescer::new()));
            let counts = Arc::new(Mutex::new(TrackCounts::default()));

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
            tauri::async_runtime::spawn(async move {
                let mut schedule = PollSchedule::new(Instant::now());
                let mut table = RequestTable::new();
                let mut ticker = tokio::time::interval(Duration::from_millis(250));
                let mut track_data_queue: VecDeque<(usize, usize)> = VecDeque::new();
                let mut faders_pending = false;

                // `PollSchedule::new` seeds every kind's last-run to `now`,
                // so nothing would be due for a full interval — up to 2s of
                // empty state right after connect. Force one immediate pass
                // over every kind so the first snapshot starts filling in
                // right away; `schedule.mark` below then puts each kind
                // back on its normal cadence.
                let start = Instant::now();
                for kind in PollKind::all() {
                    poll_kind(
                        kind,
                        start,
                        &mut table,
                        &poll_socket,
                        &poll_counts,
                        &mut track_data_queue,
                        &mut faders_pending,
                    )
                    .await;
                    schedule.mark(kind, start);
                }

                loop {
                    ticker.tick().await;
                    let now = Instant::now();

                    // Retry work a previous tick left Deferred (a
                    // single-flight address still had another request
                    // outstanding) before considering what's newly due.
                    // Dropping this, the way `if let Registration::New(_)
                    // = ...` alone would, silently loses track_data chunks
                    // 2..n and any deferred mixer_data poll forever.
                    drain_track_data_queue(&mut table, &poll_socket, &mut track_data_queue, now)
                        .await;
                    if faders_pending {
                        try_faders(&mut table, &poll_socket, now, &mut faders_pending).await;
                    }

                    for kind in schedule.due(now) {
                        poll_kind(
                            kind,
                            now,
                            &mut table,
                            &poll_socket,
                            &poll_counts,
                            &mut track_data_queue,
                            &mut faders_pending,
                        )
                        .await;
                        schedule.mark(kind, now);
                    }
                    // Requests that never came back must not block their
                    // key forever — a chunk can exceed the datagram cap at
                    // extreme scene counts and simply get no reply at all.
                    table.expire(now, Duration::from_secs(2));
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Executes one `PollKind`'s share of work for a single pass, whether that
/// pass is the forced immediate one at connect or a normal scheduled tick.
async fn poll_kind(
    kind: PollKind,
    now: Instant,
    table: &mut RequestTable,
    poll_socket: &OscSocket,
    counts: &Mutex<TrackCounts>,
    track_data_queue: &mut VecDeque<(usize, usize)>,
    faders_pending: &mut bool,
) {
    match kind {
        PollKind::TrackState => {
            // Both keyless (`KeyArity::None`), so these never Defer — they
            // settle as New or Joined every time.
            for addr in ["/live/song/get/num_tracks", "/live/song/get/num_scenes"] {
                if let Registration::New(_) = table.register(now, addr, &[]) {
                    let _ = poll_socket.send(addr, vec![]).await;
                }
            }

            let (num_tracks, num_scenes) = match counts.lock() {
                Ok(c) => (c.num_tracks, c.num_scenes),
                Err(_) => (None, None),
            };
            // track_chunks needs the real counts; skip the chunked poll
            // until both are known. Self-correcting: the requests above
            // populate them within a poll or two of connecting.
            if let (Some(num_tracks), Some(num_scenes)) = (num_tracks, num_scenes) {
                if track_data_queue.is_empty() {
                    track_data_queue.extend(track_chunks(
                        num_tracks,
                        num_scenes,
                        TRACK_DATA_PROPERTIES.len(),
                    ));
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
                match table.register(now, addr, &[]) {
                    Registration::New(_) => {
                        let _ = poll_socket.send(addr, vec![]).await;
                    }
                    // Joined: an identical request is already in flight,
                    // fine to drop. Deferred: unreachable here
                    // (`KeyArity::None` never defers) but handled rather
                    // than assumed away.
                    Registration::Joined(_) | Registration::Deferred => {}
                }
            }
        }
        PollKind::Meters => {
            let addr = "/live/master/get/output_meter_level";
            if let Registration::New(_) = table.register(now, addr, &[]) {
                let _ = poll_socket.send(addr, vec![]).await;
            }
        }
        PollKind::FocusedNotes => {
            // Left unwired: a later plan owns the focused-clip digest and
            // calls `NoteTracker` directly.
        }
    }
}

/// Drains as much of the `track_data` chunk queue as the single-flight
/// address currently allows. `track_data` is `KeyArity::Unkeyed`, so at
/// most one chunk can be outstanding at a time; the first `Deferred` means
/// every later chunk would defer too, so this stops there rather than
/// burning cycles re-registering chunks already known to be blocked.
async fn drain_track_data_queue(
    table: &mut RequestTable,
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
        match table.register(now, "/live/song/get/track_data", &args) {
            Registration::New(_) => {
                let _ = poll_socket.send("/live/song/get/track_data", args).await;
                queue.pop_front();
            }
            // An identical chunk request is already in flight; nothing
            // more to do for this one.
            Registration::Joined(_) => {
                queue.pop_front();
            }
            // Some other track_data chunk is outstanding; retry this one,
            // and everything behind it, on a later tick.
            Registration::Deferred => break,
        }
    }
}

async fn try_faders(
    table: &mut RequestTable,
    poll_socket: &OscSocket,
    now: Instant,
    pending: &mut bool,
) {
    let addr = "/live/track/get/mixer_data";
    let args = vec![OscType::Int(0), OscType::Int(-1)];
    match table.register(now, addr, &args) {
        Registration::New(_) => {
            let _ = poll_socket.send(addr, args).await;
            *pending = false;
        }
        Registration::Joined(_) => *pending = false,
        Registration::Deferred => {} // retry next tick
    }
}
