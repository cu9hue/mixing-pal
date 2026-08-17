mod bulk;
mod deltas;
mod osc;
mod tools;

use bulk::{decode_mixer_data, decode_track_data, MIXER_ADDRS, TRACK_DATA_ADDRS};
use deltas::{Coalescer, Delta};
use osc::budget::{mixer_chunks, track_chunks};
use osc::pollers::{PollKind, PollSchedule};
use osc::requests::{Registration, RequestTable};
use osc::query::LiveQuery;
use osc::socket::OscSocket;
use osc::subs::SINGLETON_SUBSCRIPTIONS;
use rosc::OscType;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tools::{ToolContext, ToolResult};

/// Property names requested per `track_data` chunk. Kept next to the chunk
/// builder because `track_chunks`' byte-budget math needs the count to
/// match exactly what actually goes on the wire.
const TRACK_DATA_PROPERTIES: [&str; 3] = ["track.name", "track.mute", "track.solo"];

/// Every address that can end up in a `Delta` the frontend actually
/// receives: subscription replies (`SINGLETON_SUBSCRIPTIONS`'s `get`
/// addresses), the two keyless counters this loop caches for `track_chunks`
/// (observed raw, same as any other reply), and `track_data`/`mixer_data`'s
/// decoded per-track addresses (`TRACK_DATA_ADDRS`/`MIXER_ADDRS` -- the raw
/// bulk addresses themselves never reach the frontend; see the receive
/// loop's `is_bulk_reply` skip). `PollKind::Selection`'s and
/// `PollKind::Meters`' own addresses are observed raw and included too.
///
/// Exported so `every_emitted_address_is_handled_or_explicitly_allowed`
/// (below) can assert this list and `apply.ts`'s address mappings
/// (`shared/handled-addresses.json`) never drift apart silently -- I4 in the
/// 2026-08-16 whole-branch review: this is the tripwire whose absence is
/// exactly why C1 (a rendered field nothing ever fetched) shipped.
pub const EMITTED_ADDRESSES: &[&str] = &[
    // SINGLETON_SUBSCRIPTIONS reply (get) addresses.
    "/live/song/get/tempo",
    "/live/song/get/is_playing",
    "/live/song/get/root_note",
    "/live/song/get/scale_name",
    "/live/song/get/loop",
    "/live/song/get/loop_start",
    "/live/song/get/loop_length",
    "/live/song/get/signature_numerator",
    "/live/song/get/signature_denominator",
    "/live/song/get/beat",
    "/live/view/get/selected_track",
    "/live/view/get/selected_scene",
    // PollKind::TrackState's own keyless counters, observed raw (see
    // TrackCounts).
    "/live/song/get/num_tracks",
    "/live/song/get/num_scenes",
    // track_data/mixer_data are Unkeyed bulk replies, skipped by observe()
    // and decoded into these instead (bulk::TRACK_DATA_ADDRS/MIXER_ADDRS).
    "/live/track/get/name",
    "/live/track/get/mute",
    "/live/track/get/solo",
    "/live/track/get/volume",
    "/live/track/get/volume_db",
    "/live/track/get/panning",
    // PollKind::Selection, observed raw.
    "/live/view/get/selected_clip",
    "/live/view/get/selected_device",
    // PollKind::Meters, observed raw.
    "/live/master/get/output_meter_level",
];

/// Every literal address the poll loop sends on the wire, outside of
/// `SINGLETON_SUBSCRIPTIONS` (checked separately, since it already has its
/// own name). Exists solely so
/// `every_poll_loop_send_and_subscription_is_read_only` (below) has a
/// concrete list to check against `osc::socket::is_read_only_address` --
/// F4 in the 2026-08-16 whole-branch review: the read-only guarantee is
/// structural (every `send_to` call asserts it), but this test is what
/// proves every address this codebase actually sends today passes that
/// assertion, rather than trusting it by inspection.
#[cfg(test)]
const POLL_LOOP_SENT_ADDRESSES: &[&str] = &[
    "/live/song/get/num_tracks",
    "/live/song/get/num_scenes",
    "/live/song/get/track_data",
    "/live/track/get/mixer_data",
    "/live/view/get/selected_clip",
    "/live/view/get/selected_device",
    "/live/master/get/output_meter_level",
];

/// How often the poll loop unconditionally resends `SINGLETON_SUBSCRIPTIONS`,
/// whether or not any traffic has arrived in between.
///
/// Not silence-gated, and this is the mechanism that recovers a project
/// switch. Confirmed against Live 12.2.5 on 2026-08-16 by reading the
/// script's own log across a real project load:
///
/// ```text
/// 18:49:56  Adding listener ... tempo     <- resend N
/// 18:50:07  Started AbletonOSC            <- Live re-instantiates the script
/// 18:50:16  Adding listener ... tempo     <- resend N+2 rebinds
/// 18:50:16  Property tempo changed: (123.0,)
/// ```
///
/// Loading a project makes Live re-instantiate the Control Surface. That
/// re-runs `init_api()`, which registers the OSC *handlers* -- but listeners
/// are only ever created when a client sends `start_listen`, so the restart
/// destroys every subscription and Live never recreates them. Meanwhile every
/// polled getter (`track_data`, `mixer_data`, `num_tracks`, meters) keeps
/// working against the new song, so traffic keeps flowing and `lastSeen` stays
/// fresh. Absence of traffic is therefore not a signal that subscriptions
/// died: a silence-gated resend would never fire, and tempo/key/scale would
/// sit frozen on the previous project's values indefinitely while the app
/// looked healthy.
///
/// One interval is also the worst-case recovery latency for that case
/// (~9s was observed above), which is why this is seconds rather than minutes.
/// The same mechanism covers "Live restarted", "Live hadn't started yet when
/// we first subscribed", and "a subscribe datagram got dropped".
///
/// Resending is safe and self-healing rather than merely harmless: a repeat
/// `_start_listen` for an existing key calls `_stop_listen` first, and for
/// these index-free song/view targets that removal resolves to the same
/// object it was registered on. It must never be extended to an indexed
/// address -- see `SINGLETON_SUBSCRIPTIONS`.
const SUBSCRIPTION_RESEND_INTERVAL: Duration = Duration::from_secs(10);

/// Same window `RequestTable::expire` uses to free a single-flight slot.
/// Reused here so `inflight_track_data`/`inflight_mixer_data` (below) can
/// never outlive the request they describe -- see
/// `clear_stale_inflight`'s doc comment for why a stranded range would
/// otherwise misattribute a later, differently-ranged reply.
const UNKEYED_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

/// Cached as replies to `/live/song/get/{num_tracks,num_scenes}` arrive
/// through the normal receive-loop observation path. `track_chunks` needs
/// the real counts, and parsing a `track_data` reply requires them anyway
/// since its clip segments are positional -- so chunked polling is skipped
/// until both are known rather than guessed.
///
/// `inflight_track_data`/`inflight_mixer_data` record the `(min, max)`
/// track range the poll loop just sent a request for, at the moment it
/// sends it. Both replies are `KeyArity::Unkeyed` -- they echo no range --
/// so this is the only place that knowledge exists once the request is on
/// the wire; the receive loop reads and clears the matching field when the
/// reply arrives, and `clear_stale_inflight` clears it if the reply never
/// does. The paired `_sent_at` fields exist only to drive that timeout and
/// are not part of the brief's stated field set.
#[derive(Default)]
struct TrackCounts {
    num_tracks: Option<usize>,
    num_scenes: Option<usize>,
    inflight_track_data: Option<(u32, u32)>,
    inflight_mixer_data: Option<(u32, u32)>,
    track_data_sent_at: Option<Instant>,
    mixer_data_sent_at: Option<Instant>,
}

/// Clears a stranded `inflight_track_data`/`inflight_mixer_data` range once
/// its request is older than `UNKEYED_REQUEST_TIMEOUT` -- the same window
/// `RequestTable::expire` uses to free the matching single-flight slot.
/// Without this, a reply that's lost in transit would leave the old range
/// sitting in `TrackCounts` forever (or until happenstance overwrites it
/// with the next successful send), so a later stray or zombie packet at the
/// same address could be decoded under a range nothing actually confirmed.
/// Called once per poll tick, alongside `RequestTable::expire`.
fn clear_stale_inflight(counts: &Mutex<TrackCounts>, now: Instant) {
    if let Ok(mut c) = counts.lock() {
        if c.track_data_sent_at
            .is_some_and(|t| now.duration_since(t) > UNKEYED_REQUEST_TIMEOUT)
        {
            c.inflight_track_data = None;
            c.track_data_sent_at = None;
        }
        if c.mixer_data_sent_at
            .is_some_and(|t| now.duration_since(t) > UNKEYED_REQUEST_TIMEOUT)
        {
            c.inflight_mixer_data = None;
            c.mixer_data_sent_at = None;
        }
    }
}

/// Everything the receive loop does with one inbound datagram: observe it,
/// resolve any request it completes, cache the two keyless counters the
/// chunker needs, and decode the two bulk replies against the range the poll
/// loop recorded when it sent them.
///
/// A free function rather than the body of `setup()`'s spawn closure, which
/// is where this logic used to live and where no test could reach it. The
/// 2026-08-16 whole-branch review found a Critical bug in exactly this seam
/// (a rendered field nothing fetched) that thirteen task reviews missed,
/// because the only way to exercise the loop was to run the app.
fn handle_inbound(
    msg: &rosc::OscMessage,
    coalescer: &Mutex<Coalescer>,
    table: &Mutex<RequestTable>,
    counts: &Mutex<TrackCounts>,
) {
    // track_data and mixer_data are raw bulk arrays
    // (up to ~1800 values) that get decoded into
    // real per-track deltas below and observed THERE
    // (via observe_delta) instead. Observing the raw
    // reply here too would coalesce and retain the
    // whole bulk array under its own request address
    // forever -- re-sent in full on every webview
    // reload via snapshot(), and never evicted,
    // since evict_tracks_at_or_beyond only matches
    // the decoded per-track addresses, not these.
    let is_bulk_reply = matches!(
        msg.addr.as_str(),
        "/live/song/get/track_data" | "/live/track/get/mixer_data"
    );
    if !is_bulk_reply {
        if let Ok(mut c) = coalescer.lock() {
            c.observe(msg);
        }
    }
    // Every inbound packet is an observation first
    // and a promise resolution second (see
    // `RequestTable::resolve`'s doc comment).
    // Resolving here -- rather than leaving a
    // single-flight slot to clear only via
    // `expire`'s 2s timeout -- is what makes the
    // rates in `PollKind::interval` the rates that
    // actually go out on the wire.
    if let Ok(mut t) = table.lock() {
        t.resolve(msg);
    }
    // The poll loop needs the real track and scene
    // counts to chunk `track_data` correctly. Cache
    // them here, through the same observation path
    // everything else already flows through,
    // instead of adding a second call site that
    // waits on its own reply.
    match (msg.addr.as_str(), msg.args.first()) {
        ("/live/song/get/num_tracks", Some(OscType::Int(n))) => {
            let new_count = (*n).max(0) as usize;
            let shrank = match counts.lock() {
                Ok(mut c) => {
                    let shrank = c
                        .num_tracks
                        .is_some_and(|old| new_count < old);
                    c.num_tracks = Some(new_count);
                    shrank
                }
                Err(_) => false,
            };
            // A shrink means at least one track was
            // deleted in Live. There is no "track
            // removed" message -- only a smaller
            // count on the next poll -- so this is
            // the only signal that stale retained
            // entries (see
            // `Coalescer::evict_tracks_at_or_beyond`)
            // need sweeping before a reload's
            // `snapshot()` can resurrect them as
            // phantom rows.
            if shrank {
                if let Ok(mut c) = coalescer.lock() {
                    let addrs: Vec<&str> = TRACK_DATA_ADDRS
                        .iter()
                        .chain(MIXER_ADDRS.iter())
                        .copied()
                        .collect();
                    c.evict_tracks_at_or_beyond(
                        &addrs,
                        new_count as u32,
                    );
                }
            }
        }
        ("/live/song/get/num_scenes", Some(OscType::Int(n))) => {
            if let Ok(mut c) = counts.lock() {
                c.num_scenes = Some((*n).max(0) as usize);
            }
        }
        _ => {}
    }

    // track_data and mixer_data are both
    // `KeyArity::Unkeyed` -- the reply echoes no
    // range -- so attributing this one to a track
    // range means reading (and clearing) whatever
    // range the poll loop most recently recorded
    // for this address in `TrackCounts`. A `None`
    // here means no range is known for this reply
    // (never sent one, or `clear_stale_inflight`
    // already reclaimed it): decoding would have to
    // guess the range, which is exactly the
    // plausible-wrong-data this design avoids, so
    // it's dropped instead.
    match msg.addr.as_str() {
        "/live/song/get/track_data" => {
            let range = match counts.lock() {
                Ok(mut c) => c.inflight_track_data.take(),
                Err(_) => None,
            };
            match range {
                Some(range) => {
                    let deltas = decode_track_data(range, &msg.args);
                    if let Ok(mut c) = coalescer.lock() {
                        for delta in deltas {
                            c.observe_delta(delta);
                        }
                    }
                }
                None => eprintln!(
                    "track_data reply arrived with no in-flight \
                     range recorded; dropping"
                ),
            }
        }
        "/live/track/get/mixer_data" => {
            let range = match counts.lock() {
                Ok(mut c) => c.inflight_mixer_data.take(),
                Err(_) => None,
            };
            match range {
                Some(range) => {
                    let deltas = decode_mixer_data(range, &msg.args);
                    if let Ok(mut c) = coalescer.lock() {
                        for delta in deltas {
                            c.observe_delta(delta);
                        }
                    }
                }
                None => eprintln!(
                    "mixer_data reply arrived with no in-flight \
                     range recorded; dropping"
                ),
            }
        }
        _ => {}
    }
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

/// Reported via the `connection_status` command so `Connection.tsx` can
/// tell a port conflict (the socket never bound, so the receive and poll
/// loops never started) apart from "bound but Live hasn't sent anything
/// yet" -- the latter is already covered by the existing `lastSeen`
/// staleness check, which is driven by actual deltas.
///
/// Fix for F3 (2026-08-16 whole-branch review): before this existed, a bind
/// failure only printed to stderr and left the window showing the
/// "not connected to Live" banner -- a confidently wrong diagnosis when the
/// real cause is a leftover probe script or a second copy of the app
/// already holding the port.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum ConnectionStatus {
    /// The socket bound; the receive and poll loops are running normally.
    /// Whether Live itself is talking to it is a separate question, answered
    /// by the frontend's own `lastSeen` staleness check.
    Bound,
    /// `OscSocket::bind()` failed before the receive/poll loops could even
    /// start. `port` and `error` let the frontend name the exact port and
    /// show the OS's own reason (almost always "address in use").
    BindFailed { port: u16, error: String },
}

impl ConnectionStatus {
    fn bind_failed(port: u16, err: &std::io::Error) -> Self {
        ConnectionStatus::BindFailed { port, error: err.to_string() }
    }
}

#[tauri::command]
fn connection_status(state: tauri::State<Arc<Mutex<ConnectionStatus>>>) -> ConnectionStatus {
    match state.lock() {
        Ok(s) => s.clone(),
        // Poisoned only if some other code panicked while holding this
        // lock, which nothing here ever does while holding it; Bound is the
        // harmless default either way -- the frontend's lastSeen staleness
        // check still catches real silence.
        Err(_) => ConnectionStatus::Bound,
    }
}

/// The webview names a tool and passes arguments; it never supplies a tool
/// definition. See `tools::tool_schema`.
#[tauri::command]
async fn execute_tool(
    name: String,
    args: serde_json::Value,
    ctx: tauri::State<'_, ToolContext>,
) -> Result<ToolResult, String> {
    // Clone out of managed state so nothing borrowed from `State` is held
    // across the await.
    let ctx = ctx.inner().clone();
    Ok(tools::execute(&ctx, &name, &args).await)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![snapshot, connection_status, execute_tool])
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

            // Managed before the bind attempt below so `connection_status`
            // is answerable regardless of how that attempt turns out.
            let connection_status = Arc::new(Mutex::new(ConnectionStatus::Bound));
            app.manage(connection_status.clone());

            // Managed before the bind attempt for the same reason
            // connection_status is: a failed bind must leave the tool
            // command answerable, reporting "not_connected" rather than
            // failing with "state not managed".
            let live_query: Arc<Mutex<Option<Arc<LiveQuery>>>> = Arc::new(Mutex::new(None));
            app.manage(ToolContext {
                coalescer: coalescer.clone(),
                query: live_query.clone(),
            });

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
                    if let Ok(mut s) = connection_status.lock() {
                        *s = ConnectionStatus::bind_failed(osc::socket::CLIENT_PORT, &e);
                    }
                    return Ok(());
                }
            };

            if let Ok(mut q) = live_query.lock() {
                *q = Some(Arc::new(LiveQuery::new(socket.clone(), table.clone())));
            }

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
                        Ok(msg) => handle_inbound(&msg, &recv_coalescer, &recv_table, &recv_counts),
                        Err(e) => {
                            eprintln!("osc recv error: {e}");
                            // "Live isn't running" (connection refused on
                            // every recv) is the normal startup state, not a
                            // rare fault, and this loop has no other
                            // throttle -- without a backoff, a persistent
                            // immediate error spins the receive task at
                            // 100% CPU in an app that's always-on-top and
                            // typically left running for a whole session.
                            tokio::time::sleep(Duration::from_millis(500)).await;
                        }
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
                let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
                // The num_tracks the queue above was built against, mirroring
                // queue_built_for's role for track_data_queue.
                let mut mixer_built_for: Option<usize> = None;

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
                        &mut mixer_queue,
                        &mut mixer_built_for,
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
                            t.expire(now, UNKEYED_REQUEST_TIMEOUT);
                        }
                        Err(_) => {
                            eprintln!(
                                "osc request table lock poisoned; cannot expire stale requests"
                            );
                        }
                    }
                    // Same reasoning, for the in-flight ranges `TrackCounts`
                    // tracks alongside the request table's own slots -- see
                    // `clear_stale_inflight`'s doc comment.
                    clear_stale_inflight(&poll_counts, now);

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
                    drain_track_data_queue(
                        &poll_table,
                        &poll_socket,
                        &poll_counts,
                        &mut track_data_queue,
                        now,
                    )
                    .await;
                    drain_mixer_data_queue(
                        &poll_table,
                        &poll_socket,
                        &poll_counts,
                        &mut mixer_queue,
                        now,
                    )
                    .await;

                    for kind in schedule.due(now) {
                        poll_kind(
                            kind,
                            now,
                            &poll_table,
                            &poll_socket,
                            &poll_counts,
                            &mut track_data_queue,
                            &mut queue_built_for,
                            &mut mixer_queue,
                            &mut mixer_built_for,
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
    mixer_queue: &mut VecDeque<(usize, usize)>,
    mixer_built_for: &mut Option<usize>,
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
                if *queue_built_for != Some(current) || track_data_queue.is_empty() {
                    // Either the first time both counts are known, or the
                    // counts changed since the queue was built (a track
                    // was added/removed mid-sweep), or a prior sweep fully
                    // drained -- track names/mute/solo refresh every 2s per
                    // the spec's poll table, so an unchanged-but-empty
                    // queue must still be rebuilt every tick, not just the
                    // first time counts become known. Regression for F1
                    // (2026-08-16 whole-branch review): the old condition
                    // only checked for a counts change, so once the single
                    // sweep for a session drained, nothing was ever queued
                    // again and track_data was sent exactly once total.
                    //
                    // Either way, whatever is still queued was built
                    // against stale counts and would request wrong ranges,
                    // so restart the sweep instead of draining the stale
                    // one out first.
                    track_data_queue.clear();
                    track_data_queue.extend(track_chunks(
                        num_tracks,
                        num_scenes,
                        TRACK_DATA_PROPERTIES.len(),
                        // TRACK_DATA_PROPERTIES is all track.*, no clip.*
                        // properties -- see track_chunks' doc comment for
                        // why that term must stay 0 here.
                        0,
                    ));
                    *queue_built_for = Some(current);
                }
                drain_track_data_queue(table, poll_socket, counts, track_data_queue, now).await;
            }
        }
        PollKind::Faders => {
            let num_tracks = match counts.lock() {
                Ok(c) => c.num_tracks,
                Err(_) => None,
            };
            // Nothing goes out until num_tracks is known: a chunked sweep
            // needs a real count. That costs one poll interval on connect
            // and saves a round trip whose reply could only be discarded.
            if let Some(n) = num_tracks {
                // `|| is_empty()` for the same reason TrackState has it (F1,
                // 2026-08-16 whole-branch review): a sweep that drains must
                // be rebuilt on the next tick, or faders freeze after one
                // pass while everything else keeps updating.
                if *mixer_built_for != Some(n) || mixer_queue.is_empty() {
                    mixer_queue.clear();
                    mixer_queue.extend(mixer_chunks(n));
                    *mixer_built_for = Some(n);
                }
                drain_mixer_data_queue(table, poll_socket, counts, mixer_queue, now).await;
            }
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
    counts: &Mutex<TrackCounts>,
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
                // Record exactly the range just sent, so the receive loop
                // can decode this reply's keyless values back into the
                // right track indices when it arrives (see
                // `TrackCounts::inflight_track_data`'s doc comment).
                if let Ok(mut c) = counts.lock() {
                    c.inflight_track_data = Some((min as u32, max as u32));
                    c.track_data_sent_at = Some(now);
                }
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

/// Drains as much of the `mixer_data` chunk queue as the single-flight
/// address currently allows. Same shape as `drain_track_data_queue`, and for
/// the same reason: `mixer_data` is `KeyArity::Unkeyed`, so at most one
/// chunk can be outstanding at a time, and the first `Deferred` means every
/// later chunk would defer too.
async fn drain_mixer_data_queue(
    table: &Mutex<RequestTable>,
    poll_socket: &OscSocket,
    counts: &Mutex<TrackCounts>,
    queue: &mut VecDeque<(usize, usize)>,
    now: Instant,
) {
    while let Some(&(min, max)) = queue.front() {
        let args = vec![OscType::Int(min as i32), OscType::Int(max as i32)];
        let registration = match table.lock() {
            Ok(mut t) => t.register(now, "/live/track/get/mixer_data", &args),
            Err(_) => {
                eprintln!(
                    "osc request table lock poisoned; skipping mixer_data chunk this tick"
                );
                break;
            }
        };
        match registration {
            Registration::New(_) => {
                let _ = poll_socket.send("/live/track/get/mixer_data", args).await;
                queue.pop_front();
                // The exact range just sent. Plan 1 asked for `(0, -1)` and
                // had to reconstruct the extent from a separately-polled
                // count, dropping the reply outright whenever that count was
                // not yet known; a concrete range removes the guess.
                if let Ok(mut c) = counts.lock() {
                    c.inflight_mixer_data = Some((min as u32, max as u32));
                    c.mixer_data_sent_at = Some(now);
                }
            }
            Registration::Joined(_) | Registration::Deferred => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rosc::OscMessage;
    use std::collections::HashSet;

    #[derive(serde::Deserialize)]
    struct HandledAddresses {
        #[serde(rename = "songFields")]
        song_fields: Vec<String>,
        #[serde(rename = "trackFields")]
        track_fields: Vec<String>,
    }

    fn load_handled_addresses() -> HandledAddresses {
        // Same manifest src/live/addresses.test.ts checks against apply.ts's
        // actual SONG_FIELDS/TRACK_FIELDS -- see that file's comment. A pure
        // Rust test can't see apply.ts, so both sides cross-check against
        // this one shared file instead of against each other directly.
        serde_json::from_str(include_str!("../../shared/handled-addresses.json"))
            .expect("shared/handled-addresses.json must be valid JSON matching HandledAddresses")
    }

    #[test]
    fn emitted_addresses_includes_every_bulk_decoded_address() {
        // Sanity check on EMITTED_ADDRESSES itself: it must actually contain
        // what TRACK_DATA_ADDRS/MIXER_ADDRS produce, so it can't drift from
        // what decode_track_data/decode_mixer_data really emit.
        for addr in TRACK_DATA_ADDRS.iter().chain(MIXER_ADDRS.iter()) {
            assert!(
                EMITTED_ADDRESSES.contains(addr),
                "{addr} is decoded from a bulk reply but missing from EMITTED_ADDRESSES"
            );
        }
    }

    #[test]
    fn every_emitted_address_is_handled_by_the_frontend_or_explicitly_allowed() {
        let manifest = load_handled_addresses();
        let handled: HashSet<&str> = manifest
            .song_fields
            .iter()
            .chain(manifest.track_fields.iter())
            .map(String::as_str)
            .collect();

        // Known, deliberate gaps -- backend emits these, apply.ts doesn't
        // model them (yet). Each entry needs a reason, not just a listing,
        // per I4 in the 2026-08-16 whole-branch review.
        let allowed_unhandled: &[&str] = &[
            // Polled every 1s/2s but SetState has no field for either yet.
            "/live/view/get/selected_clip",
            "/live/view/get/selected_device",
            "/live/master/get/output_meter_level",
            // Subscribed via SINGLETON_SUBSCRIPTIONS but not modelled in
            // SetState -- seven properties, deliberately unmodelled.
            "/live/song/get/loop",
            "/live/song/get/loop_start",
            "/live/song/get/loop_length",
            "/live/song/get/signature_numerator",
            "/live/song/get/signature_denominator",
            "/live/song/get/beat",
            "/live/view/get/selected_scene",
            // Cached internally for track_chunks' byte-budget math; observed
            // raw like any other reply, but not (yet) surfaced in SetState.
            // num_tracks is NOT here (F2, 2026-08-16 whole-branch review):
            // apply.ts now handles it directly, pruning state.tracks of any
            // stale index a shrink leaves behind -- see NUM_TRACKS_ADDR.
            "/live/song/get/num_scenes",
        ];

        for addr in EMITTED_ADDRESSES {
            assert!(
                handled.contains(addr) || allowed_unhandled.contains(addr),
                "{addr} is emitted to the frontend but apply.ts has no mapping \
                 for it and it is not in allowed_unhandled -- add a mapping in \
                 apply.ts (and shared/handled-addresses.json) or extend \
                 allowed_unhandled with a reason"
            );
        }
    }

    #[test]
    fn every_frontend_handled_address_is_emitted_or_explicitly_allowed() {
        let manifest = load_handled_addresses();

        // apply.ts models per-track meters ahead of backend support: they
        // need mixer_data extended again, and the spec polls them only for
        // the focused/armed/soloed subset, not the whole table. volume_db
        // used to be here too -- C1 (2026-08-16 whole-branch review) -- and
        // is now actually emitted.
        let allowed_unemitted: &[&str] = &["/live/track/get/output_meter_level"];

        for addr in manifest.song_fields.iter().chain(manifest.track_fields.iter()) {
            assert!(
                EMITTED_ADDRESSES.contains(&addr.as_str()) || allowed_unemitted.contains(&addr.as_str()),
                "{addr} is mapped in apply.ts but nothing in the backend ever \
                 emits it, and it is not in allowed_unemitted -- wire it up or \
                 extend allowed_unemitted with a reason"
            );
        }
    }

    #[test]
    fn every_poll_loop_send_and_subscription_is_read_only() {
        // F4 (2026-08-16 whole-branch review): every address this codebase
        // actually sends must pass send_to's structural read-only check.
        // SINGLETON_SUBSCRIPTIONS and POLL_LOOP_SENT_ADDRESSES together are
        // every literal address any send()/send_to() call site in this
        // codebase uses today.
        for addr in SINGLETON_SUBSCRIPTIONS.iter().chain(POLL_LOOP_SENT_ADDRESSES.iter()) {
            assert!(
                osc::socket::is_read_only_address(addr),
                "{addr} would be refused by send_to's read-only guard"
            );
        }
    }

    #[test]
    fn bind_failed_status_names_the_port_and_carries_the_os_error() {
        let err = std::io::Error::new(std::io::ErrorKind::AddrInUse, "address already in use");
        let status = ConnectionStatus::bind_failed(11001, &err);
        match status {
            ConnectionStatus::BindFailed { port, error } => {
                assert_eq!(port, 11001);
                assert!(error.contains("already in use"), "expected the OS error text, got {error:?}");
            }
            other => panic!("expected BindFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_held_client_port_makes_the_real_bind_fail_the_way_setup_reacts_to() {
        // Reproduces the actual failure `setup()` detects: something else
        // (a leftover probe script, a second copy of the app) already holds
        // the port OscSocket::bind() wants. This is what F3 turns into a
        // ConnectionStatus::BindFailed instead of the old silent stderr
        // print and a misleading "Live isn't running" banner.
        let holder = OscSocket::bind_to(0, 0).await.unwrap();
        let held_port = holder.local_port();
        let result = OscSocket::bind_to(held_port, 0).await;
        assert!(
            result.is_err(),
            "binding an already-held port must fail, not silently succeed"
        );
    }

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
        //
        // UDP guarantees nothing about arrival order between independent
        // sends, even over loopback, so this checks the SET of addresses
        // received rather than asserting they arrive in send order.
        let later = start + SUBSCRIPTION_RESEND_INTERVAL;
        maybe_resubscribe(&poll_socket, later, &mut last_resubscribe).await;
        let mut received = std::collections::HashSet::new();
        for _ in SINGLETON_SUBSCRIPTIONS {
            let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
                .await
                .expect("expected every SINGLETON_SUBSCRIPTIONS address to be resent");
            received.insert(msg.addr);
        }
        let expected: std::collections::HashSet<String> = SINGLETON_SUBSCRIPTIONS
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(received, expected);
        assert_eq!(last_resubscribe, later);
    }

    #[tokio::test]
    async fn track_data_queue_retries_deferred_chunks_across_ticks() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts::default());
        let mut queue: VecDeque<(usize, usize)> = VecDeque::from([(0, 1), (1, 2), (2, 3)]);
        let start = Instant::now();

        // First pass: track_data is single-flight per address, so only
        // chunk 1 goes out. Chunks 2 and 3 must stay queued, not be
        // dropped, per the brief's carried-forward Deferred-retry fix.
        drain_track_data_queue(&table, &poll_socket, &counts, &mut queue, start).await;

        let msg = recv_message(&listener).await;
        assert_eq!(msg.addr, "/live/song/get/track_data");
        assert_eq!(msg.args[0], OscType::Int(0));
        assert_eq!(msg.args[1], OscType::Int(1));
        assert_eq!(queue.len(), 2);
        assert_eq!(queue.front(), Some(&(1, 2)));
        assert_eq!(
            counts.lock().unwrap().inflight_track_data,
            Some((0, 1)),
            "the exact chunk just sent must be recorded so the receive loop can decode its reply"
        );

        // A second pass before the slot frees must not send anything new.
        drain_track_data_queue(&table, &poll_socket, &counts, &mut queue, start).await;
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
        drain_track_data_queue(&table, &poll_socket, &counts, &mut queue, later).await;
        let msg2 = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect("expected chunk 2 to be sent once the slot expired");
        assert_eq!(msg2.args[0], OscType::Int(1));
        assert_eq!(msg2.args[1], OscType::Int(2));
        assert_eq!(queue.len(), 1);
        assert_eq!(counts.lock().unwrap().inflight_track_data, Some((1, 2)));
    }

    // --- poll_kind's TrackState arm -----------------------------------
    //
    // Regression coverage for F1 (2026-08-16 whole-branch review): before
    // this fix, `poll_kind` had no test at all, and the bug it shipped with
    // -- track_data sent exactly once per session -- lived entirely in the
    // refill condition below `drain_track_data_queue`, which the existing
    // `track_data_queue_retries_deferred_chunks_across_ticks` test never
    // exercises (it hands `drain_track_data_queue` a pre-populated queue
    // directly, bypassing `poll_kind` entirely).

    #[tokio::test]
    async fn poll_kind_trackstate_refills_the_queue_after_it_drains_on_a_later_tick() {
        // The old refill condition (`*queue_built_for != Some(current)`)
        // only rebuilt the queue when (num_tracks, num_scenes) changed. For
        // a small set, the queue built on the first tick is a single chunk
        // that drains immediately in the same tick -- so every later tick
        // found the counts unchanged and the queue empty, and skipped the
        // refill forever. Track names/mute/solo refresh every 2s per the
        // spec's poll table; this proves they actually do.
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts {
            num_tracks: Some(3),
            num_scenes: Some(1),
            ..Default::default()
        });
        let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut queue_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;
        let start = Instant::now();

        // First tick: counts are already known, so the queue builds and its
        // one chunk (a 3-track/1-scene set fits in a single chunk) drains
        // immediately, in the same call.
        poll_kind(
            PollKind::TrackState,
            start,
            &table,
            &poll_socket,
            &counts,
            &mut queue,
            &mut queue_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;

        let mut first_tick_addrs = HashSet::new();
        for _ in 0..3 {
            let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
                .await
                .expect("expected num_tracks, num_scenes, and track_data on the first tick");
            first_tick_addrs.insert(msg.addr);
        }
        assert!(first_tick_addrs.contains("/live/song/get/track_data"));
        assert_eq!(queue_built_for, Some((3, 1)));
        assert!(queue.is_empty(), "the single chunk must have drained immediately");

        // Free track_data's single-flight slot, as the receive loop would
        // once the reply actually arrives.
        {
            let mut t = table.lock().unwrap();
            t.resolve(&OscMessage { addr: "/live/song/get/track_data".to_string(), args: vec![] });
        }

        // Second tick, same counts -- nothing changed in Live. track_data
        // must still be resent.
        let later = start + Duration::from_secs(2);
        poll_kind(
            PollKind::TrackState,
            later,
            &table,
            &poll_socket,
            &counts,
            &mut queue,
            &mut queue_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;

        // num_tracks/num_scenes are still pending from the first tick (never
        // resolved), so register_and_send must not resend them -- only
        // track_data should go out this time.
        let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect(
                "track_data must be resent once the queue has drained, \
                 even though counts didn't change",
            );
        assert_eq!(msg.addr, "/live/song/get/track_data");
        let nothing_more =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(nothing_more.is_err(), "num_tracks/num_scenes must not be resent while still pending");
    }

    #[tokio::test]
    async fn poll_kind_trackstate_discards_a_partial_sweep_when_counts_change() {
        // A track add/remove mid-sweep must restart the sweep against the
        // new counts rather than finish draining ranges that no longer
        // describe the real set.
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        // 1200 tracks / 1 scene, 3 track.* properties: tracks_per_chunk is
        // fixed at budget_values()/3 == 597 for a clip_props=0 request, so
        // this yields three chunks: (0,597), (597,1194), (1194,1200).
        let counts = Mutex::new(TrackCounts {
            num_tracks: Some(1200),
            num_scenes: Some(1),
            ..Default::default()
        });
        let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut queue_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;
        let start = Instant::now();

        poll_kind(
            PollKind::TrackState,
            start,
            &table,
            &poll_socket,
            &counts,
            &mut queue,
            &mut queue_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;
        // Drain the num_tracks/num_scenes/track_data datagrams this tick
        // sent; the queue now holds the two chunks track_data's
        // single-flight slot deferred.
        for _ in 0..3 {
            tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
                .await
                .expect("expected num_tracks, num_scenes, and the first track_data chunk");
        }
        assert_eq!(queue_built_for, Some((1200, 1)));
        assert_eq!(
            queue,
            VecDeque::from([(597, 1194), (1194, 1200)]),
            "chunks 2 and 3 must still be queued, not dropped"
        );

        // A track was deleted mid-sweep: num_tracks drops to 800. Free the
        // single-flight slot first, as the receive loop would once the
        // first chunk's reply arrives.
        {
            let mut t = table.lock().unwrap();
            t.resolve(&OscMessage { addr: "/live/song/get/track_data".to_string(), args: vec![] });
        }
        counts.lock().unwrap().num_tracks = Some(800);

        let later = start + Duration::from_secs(2);
        poll_kind(
            PollKind::TrackState,
            later,
            &table,
            &poll_socket,
            &counts,
            &mut queue,
            &mut queue_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;

        assert_eq!(queue_built_for, Some((800, 1)));
        // even_split(800, 597) == [(0,597), (597,800)]; the first chunk
        // sends immediately and is popped, leaving only the second queued.
        // Neither of the old (597,1194)/(1194,1200) ranges -- built against
        // the stale 1200-track count -- may survive the rebuild.
        assert_eq!(
            queue,
            VecDeque::from([(597, 800)]),
            "the stale sweep must be discarded and rebuilt against the new count, \
             not finished or merged with the old one"
        );
        assert_eq!(counts.lock().unwrap().inflight_track_data, Some((0, 597)));
    }

    #[tokio::test]
    async fn poll_kind_trackstate_sends_no_track_data_while_counts_are_unknown() {
        // The very first tick(s) after connect can fire before either
        // num_tracks or num_scenes has a reply yet. track_chunks needs both
        // real counts, so nothing chunked may go out until then.
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts::default());
        let mut queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut queue_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;
        let start = Instant::now();

        poll_kind(
            PollKind::TrackState,
            start,
            &table,
            &poll_socket,
            &counts,
            &mut queue,
            &mut queue_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;

        let mut seen = HashSet::new();
        for _ in 0..2 {
            let msg = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
                .await
                .expect("expected num_tracks and num_scenes requests");
            seen.insert(msg.addr);
        }
        let expected: HashSet<String> = ["/live/song/get/num_tracks", "/live/song/get/num_scenes"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(seen, expected);

        let nothing_more =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(nothing_more.is_err(), "track_data must not be sent while counts are unknown");
        assert!(queue.is_empty());
        assert_eq!(queue_built_for, None);
    }

    #[tokio::test]
    async fn mixer_data_queue_retries_deferred_chunks_across_ticks() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts::default());
        let mut queue: VecDeque<(usize, usize)> = VecDeque::from([(0, 331), (331, 400)]);
        let start = Instant::now();

        drain_mixer_data_queue(&table, &poll_socket, &counts, &mut queue, start).await;
        let msg = recv_message(&listener).await;
        assert_eq!(msg.addr, "/live/track/get/mixer_data");
        assert_eq!(msg.args[0], OscType::Int(0));
        assert_eq!(msg.args[1], OscType::Int(331));
        assert_eq!(queue.len(), 1, "chunk 2 must stay queued, not be dropped");
        assert_eq!(
            counts.lock().unwrap().inflight_mixer_data,
            Some((0, 331)),
            "the exact range sent must be recorded, not a count-derived guess"
        );

        let later = start + Duration::from_secs(3);
        {
            let mut t = table.lock().unwrap();
            t.expire(later, Duration::from_secs(2));
        }
        drain_mixer_data_queue(&table, &poll_socket, &counts, &mut queue, later).await;
        let msg2 = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect("expected chunk 2 once the slot expired");
        assert_eq!(msg2.args[0], OscType::Int(331));
        assert_eq!(counts.lock().unwrap().inflight_mixer_data, Some((331, 400)));
    }

    #[tokio::test]
    async fn poll_kind_faders_sends_nothing_while_num_tracks_is_unknown() {
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts::default());
        let mut track_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut track_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;

        poll_kind(
            PollKind::Faders,
            Instant::now(),
            &table,
            &poll_socket,
            &counts,
            &mut track_queue,
            &mut track_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;

        let nothing =
            tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
        assert!(nothing.is_err(), "a chunked sweep must wait for a real track count");
        assert!(mixer_queue.is_empty());
        assert_eq!(mixer_built_for, None);
    }

    #[tokio::test]
    async fn poll_kind_faders_refills_the_queue_after_it_drains() {
        // The F1 lesson, applied to faders: a single-chunk sweep drains inside
        // its own tick, so a refill condition that only fires on a count change
        // would send mixer_data exactly once per session and freeze every fader.
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts { num_tracks: Some(8), ..Default::default() });
        let mut track_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut track_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;
        let start = Instant::now();

        poll_kind(
            PollKind::Faders,
            start,
            &table,
            &poll_socket,
            &counts,
            &mut track_queue,
            &mut track_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;
        let first = recv_message(&listener).await;
        assert_eq!(first.args[1], OscType::Int(8));

        // Free the slot as the receive loop would once the reply lands.
        {
            let mut t = table.lock().unwrap();
            t.resolve(&OscMessage {
                addr: "/live/track/get/mixer_data".to_string(),
                args: vec![],
            });
        }

        let later = start + Duration::from_secs(2);
        poll_kind(
            PollKind::Faders,
            later,
            &table,
            &poll_socket,
            &counts,
            &mut track_queue,
            &mut track_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;
        let second = tokio::time::timeout(Duration::from_millis(200), recv_message(&listener))
            .await
            .expect("mixer_data must be resent once the queue drained");
        assert_eq!(second.addr, "/live/track/get/mixer_data");
    }

    #[test]
    fn clear_stale_inflight_reclaims_a_range_whose_reply_never_arrived() {
        let counts = Mutex::new(TrackCounts {
            inflight_track_data: Some((0, 8)),
            track_data_sent_at: Some(Instant::now()),
            inflight_mixer_data: Some((0, 8)),
            mixer_data_sent_at: Some(Instant::now()),
            ..Default::default()
        });
        let start = Instant::now();

        // Still within the timeout: nothing is cleared.
        clear_stale_inflight(&counts, start);
        {
            let c = counts.lock().unwrap();
            assert_eq!(c.inflight_track_data, Some((0, 8)));
            assert_eq!(c.inflight_mixer_data, Some((0, 8)));
        }

        // Past the timeout: both stranded ranges are reclaimed.
        let later = start + UNKEYED_REQUEST_TIMEOUT + Duration::from_millis(1);
        clear_stale_inflight(&counts, later);
        let c = counts.lock().unwrap();
        assert_eq!(c.inflight_track_data, None);
        assert_eq!(c.inflight_mixer_data, None);
    }

    // --- handle_inbound ------------------------------------------------
    //
    // The receive loop's body used to live inside setup()'s spawn closure,
    // where no test could reach it. These three cover invariants that were
    // only ever asserted by reading the code.

    fn inbound_fixture() -> (Mutex<Coalescer>, Mutex<RequestTable>, Mutex<TrackCounts>) {
        (
            Mutex::new(Coalescer::new()),
            Mutex::new(RequestTable::new()),
            Mutex::new(TrackCounts::default()),
        )
    }

    #[test]
    fn a_bulk_reply_is_never_retained_under_its_own_raw_address() {
        // The raw track_data array is up to ~1800 values. Retaining it would
        // replay the whole array on every webview reload via snapshot(), and
        // evict_tracks_at_or_beyond only matches the decoded per-track
        // addresses, so it would never be cleaned up either.
        let (coalescer, table, counts) = inbound_fixture();
        counts.lock().unwrap().inflight_track_data = Some((0, 1));

        handle_inbound(
            &OscMessage {
                addr: "/live/song/get/track_data".to_string(),
                args: vec![
                    OscType::String("Kick".into()),
                    OscType::Bool(false),
                    OscType::Bool(true),
                ],
            },
            &coalescer,
            &table,
            &counts,
        );

        let snapshot = coalescer.lock().unwrap().snapshot();
        assert!(
            snapshot.iter().all(|d| d.addr != "/live/song/get/track_data"),
            "the raw bulk array must never be retained"
        );
        assert!(
            snapshot.iter().any(|d| d.addr == "/live/track/get/name"),
            "the decoded per-track deltas must be retained instead"
        );
    }

    #[test]
    fn a_bulk_reply_with_no_recorded_range_is_dropped_rather_than_decoded() {
        // track_data echoes no range, so the only knowledge of which tracks a
        // reply describes is the range the poll loop recorded when it sent the
        // request. With none recorded, decoding would have to guess.
        let (coalescer, table, counts) = inbound_fixture();

        handle_inbound(
            &OscMessage {
                addr: "/live/song/get/track_data".to_string(),
                args: vec![
                    OscType::String("Kick".into()),
                    OscType::Bool(false),
                    OscType::Bool(true),
                ],
            },
            &coalescer,
            &table,
            &counts,
        );

        assert!(coalescer.lock().unwrap().snapshot().is_empty());
    }

    #[test]
    fn a_num_tracks_shrink_evicts_retained_rows_for_tracks_that_no_longer_exist() {
        let (coalescer, table, counts) = inbound_fixture();
        counts.lock().unwrap().inflight_track_data = Some((0, 2));

        handle_inbound(
            &OscMessage {
                addr: "/live/song/get/track_data".to_string(),
                args: vec![
                    OscType::String("Kick".into()),
                    OscType::Bool(false),
                    OscType::Bool(false),
                    OscType::String("Bass".into()),
                    OscType::Bool(false),
                    OscType::Bool(false),
                ],
            },
            &coalescer,
            &table,
            &counts,
        );

        for n in [2, 1] {
            handle_inbound(
                &OscMessage {
                    addr: "/live/song/get/num_tracks".to_string(),
                    args: vec![OscType::Int(n)],
                },
                &coalescer,
                &table,
                &counts,
            );
        }

        let names: Vec<_> = coalescer
            .lock()
            .unwrap()
            .snapshot()
            .into_iter()
            .filter(|d| d.addr == "/live/track/get/name")
            .collect();
        assert_eq!(names.len(), 1, "track 1's retained row must go when the set shrinks to 1");
        assert_eq!(names[0].args[0], serde_json::json!(0));
    }
}
