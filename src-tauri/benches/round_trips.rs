//! What a tool call actually costs: round trips against a tick-accurate
//! stand-in for Live.
//!
//! `hot_paths.rs` measures this app's CPU. This file measures the thing that
//! dwarfs it. `manager.py`'s `tick` runs every 100 ms and calls
//! `osc_server.process()`, which drains the whole socket in one
//! `while True: recvfrom(...)` loop and answers every datagram it finds
//! before returning. So:
//!
//!   * one round trip costs up to one tick, whatever the payload
//!   * N requests sent CONCURRENTLY still cost one tick
//!   * N requests sent SERIALLY cost N ticks
//!
//! AND ONE THING THAT BLUNTS ALL THREE. `process()`'s only exception
//! handling wraps the whole drain loop, and `send()` re-raises anything
//! that is not a `BuildError`. So a handler that raises -- or an oversized
//! reply, whose `sendto` raises EMSGSIZE -- breaks out of the drain, and
//! every datagram still queued behind it waits for the NEXT tick. A batch
//! of concurrent requests therefore costs one tick per failure inside it,
//! not one tick total. The fake models this, because without it a
//! concurrent pager measures as free exactly where it is not.
//!
//! That is the entire performance model, and it is why the interesting
//! number for any change here is "how many serial round trips does this
//! tool make", not "how fast is the decode".
//!
//! `FakeLive` below reproduces that shape exactly, including the failure
//! that shapes the paging code: a reply past `MAX_DATAGRAM` makes Live's
//! `sendto` raise, so the client receives NOTHING and can only tell by
//! timing out.
//!
//! TIME IS SCALED 10:1. A real tick is 100 ms and a real `QUERY_TIMEOUT` is
//! 2 s; here they are 10 ms and 200 ms. The ratio is what matters, so every
//! number this file prints is a real-world millisecond count divided by ten.
//!
//! Run: cargo bench --features bench --bench round_trips

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion};
use mixing_pal_lib::bench_api::*;
use rosc::OscType;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// A real Live tick is 100 ms. See `manager.py`'s `tick`.
const TICK: Duration = Duration::from_millis(10);
/// A real `QUERY_TIMEOUT` is 2 s, the same 20:1 ratio to the tick.
const TIMEOUT: Duration = Duration::from_millis(200);

/// Notes per beat in the "dense" clip. 358 notes is the per-datagram
/// ceiling (`(MAX_DATAGRAM - 256) / 5 / 5`), so at this density a window
/// wider than ~9 beats cannot be answered at all.
const DENSE_NOTES_PER_BEAT: usize = 40;

/// How many datagrams the client sent. The primary metric: at one tick per
/// SERIAL round trip, this is what a tool's latency is made of.
#[derive(Default)]
struct Counters {
    requests: AtomicU64,
    dropped_oversize: AtomicU64,
    /// Ticks whose drain was cut short by a raising handler or an oversized
    /// reply. Each one delays every request still queued behind it.
    drain_aborts: AtomicU64,
}

/// The set `FakeLive` answers about.
#[derive(Clone)]
struct Set {
    tracks: usize,
    devices_per_track: usize,
    clip_length_beats: f32,
    notes_per_beat: usize,
    /// What fraction of the clip's length actually holds notes. 1.0 spreads
    /// them evenly; 0.25 crams every one of them into the first quarter and
    /// leaves the rest empty. Window sizing assumes even density, so this
    /// is the shape that still falls back to halve-and-retry.
    cluster: f32,
    /// Whether the first device on each track is a Rack.
    racks: bool,
    num_parameters: usize,
}

impl Default for Set {
    fn default() -> Self {
        Self {
            tracks: 40,
            devices_per_track: 4,
            clip_length_beats: 128.0,
            notes_per_beat: 1,
            cluster: 1.0,
            racks: false,
            num_parameters: 130,
        }
    }
}

/// What one request does to Live's drain loop.
enum Served {
    /// The handler returned a reply tuple.
    Answer(Vec<OscType>),
    /// The handler returned None. `process_message` sends nothing and the
    /// drain continues -- this is what `mixingpal`'s own handlers do
    /// instead of raising.
    Silent,
    /// The handler raised, or the reply was too large for `sendto`. Either
    /// way the exception escapes `process_message` into `process()`'s outer
    /// handler and ABORTS the rest of this tick's drain.
    Raises,
}

fn reply_for(set: &Set, addr: &str, args: &[OscType]) -> Option<Vec<OscType>> {
    let int = |i: usize| args.get(i).and_then(|a| match a {
        OscType::Int(v) => Some(*v),
        _ => None,
    });
    let float = |i: usize| args.get(i).and_then(|a| match a {
        OscType::Float(v) => Some(*v),
        _ => None,
    });
    match addr {
        "/live/mixingpal/get/device_chain/fingerprint" => {
            let track = int(0)?;
            if track < 0 || track as usize >= set.tracks {
                return None;
            }
            Some(vec![
                OscType::Int(track),
                OscType::Int(set.devices_per_track as i32),
                OscType::String("a".repeat(64)),
            ])
        }
        "/live/mixingpal/get/device_chain" => {
            let (track, start, span) = (int(0)?, int(1)?, int(2)?);
            if track < 0 || track as usize >= set.tracks || start < 0 || span <= 0 {
                return None;
            }
            let mut out = vec![
                OscType::Int(track),
                OscType::Int(start),
                OscType::Int(set.devices_per_track as i32),
            ];
            for d in (start as usize..set.devices_per_track).take((span as usize).min(256)) {
                out.push(OscType::String(format!("EQ Eight {d}")));
                out.push(OscType::Bool(d == 0 && set.racks));
            }
            Some(out)
        }
        "/live/clip/get/length" => Some(vec![
            OscType::Int(int(0)?),
            OscType::Int(int(1)?),
            OscType::Float(set.clip_length_beats),
        ]),
        "/live/clip/get/num_notes" => {
            let count = (set.clip_length_beats as f64 * set.notes_per_beat as f64) as i32;
            Some(vec![
                OscType::Int(int(0)?),
                OscType::Int(int(1)?),
                OscType::Int(count),
                OscType::String("b".repeat(64)),
                OscType::Float(set.clip_length_beats),
                OscType::Bool(false),
                OscType::Float(0.0),
                OscType::Float(0.0),
                OscType::Float(0.0),
                OscType::Float(set.clip_length_beats),
            ])
        }
        "/live/clip/get/notes_window" => {
            let (track, clip, window) = (int(0)?, int(1)?, int(2)?);
            let (start, span) = (float(5)?, float(6)?);
            let mut out = vec![OscType::Int(track), OscType::Int(clip), OscType::Int(window)];
            // The notes sit on one absolute grid across the whole clip and
            // the window merely selects from it. Generating `span * density`
            // notes per window instead would truncate once per window, so
            // the totals would depend on how the client chose to page --
            // and the coverage figure this bench reports would be measuring
            // the fake, not the tool.
            let total = (set.clip_length_beats as f64 * set.notes_per_beat as f64) as usize;
            let (from, to) = (f64::from(start), f64::from(start) + f64::from(span.max(0.0)));
            for i in 0..total {
                // Use the same representable coordinate for selection and reply.
                let at = (i as f64 / set.notes_per_beat as f64 * set.cluster as f64) as f32;
                let coordinate = f64::from(at);
                if coordinate < from || coordinate >= to {
                    continue;
                }
                out.extend([
                    OscType::Int(36 + (i % 60) as i32),
                    OscType::Float(at),
                    OscType::Float(0.25),
                    OscType::Float(100.0),
                    OscType::Bool(false),
                ]);
            }
            Some(out)
        }
        // One address in place of the two upstream ones, so a bracketed
        // read costs two round trips rather than four.
        "/live/mixingpal/get/device/identity" => Some(vec![
            OscType::Int(int(0)?),
            args.get(1)?.clone(),
            OscType::String("Operator".to_string()),
            OscType::Int(set.num_parameters as i32),
        ]),
        "/live/device/get/parameters/name_range"
        | "/live/device/get/parameters/value_string_range" => {
            let track = int(0)?;
            let (start, span) = (int(2)? as usize, int(3)? as usize);
            let end = (start + span).min(set.num_parameters);
            let mut out = vec![
                OscType::Int(track),
                // The device path, echoed back as sent.
                args.get(1)?.clone(),
                OscType::Int(start as i32),
            ];
            for i in start..end {
                out.push(OscType::String(if addr.ends_with("name_range") {
                    format!("Oscillator {i} Coarse")
                } else {
                    format!("{}.0 Hz", 100 + i)
                }));
            }
            Some(out)
        }
        _ => None,
    }
}

/// Byte cost of an OSC reply, the way `budget.rs` models it: 4 bytes plus a
/// type tag for a number, and a null-terminated 4-byte-aligned string.
fn encoded_size(addr: &str, args: &[OscType]) -> usize {
    let mut bytes = addr.len().div_ceil(4) * 4 + args.len().div_ceil(4) * 4 + 8;
    for a in args {
        bytes += match a {
            OscType::String(s) => (s.len() + 1).div_ceil(4) * 4,
            _ => 4,
        };
    }
    bytes
}

/// Drives one tick loop: sleep, drain everything queued, answer it. The
/// drain is `try_recv_from` until it would block, which is what
/// `osc_server.process()` does with a non-blocking socket.
fn spawn_fake_live(
    socket: Arc<OscSocket>,
    client_port: u16,
    set: Set,
    counters: Arc<Counters>,
) {
    // The kernel's UDP receive buffer, modelled explicitly: one reader task
    // takes datagrams off the socket as they land (Live's socket is
    // non-blocking and always draining), and the tick loop below consumes
    // whatever accumulated since the previous tick.
    let (tx, mut backlog) = tokio::sync::mpsc::unbounded_channel();
    let reader = socket.clone();
    tokio::spawn(async move {
        while let Ok(msg) = reader.recv().await {
            if tx.send(msg).is_err() {
                return;
            }
        }
    });
    tokio::spawn(async move {
        // Requests this tick could not reach because an earlier one in the
        // batch aborted the drain. In real Live they are simply still in
        // the kernel buffer; the datagram that RAISED has already been
        // consumed by recvfrom and is lost.
        let mut carried: Vec<rosc::OscMessage> = Vec::new();
        loop {
            tokio::time::sleep(TICK).await;
            let mut batch = std::mem::take(&mut carried);
            while let Ok(msg) = backlog.try_recv() {
                batch.push(msg);
            }

            let mut drained = batch.into_iter();
            while let Some(msg) = drained.next() {
                counters.requests.fetch_add(1, Ordering::Relaxed);
                let served = match reply_for(&set, &msg.addr, &msg.args) {
                    None => Served::Silent,
                    // Past MAX_DATAGRAM Live's own sendto raises and the
                    // client gets nothing at all -- the failure the
                    // halve-and-retry paging exists to discover.
                    Some(reply) if encoded_size(&msg.addr, &reply) > MAX_DATAGRAM => {
                        counters.dropped_oversize.fetch_add(1, Ordering::Relaxed);
                        Served::Raises
                    }
                    Some(reply) => Served::Answer(reply),
                };
                match served {
                    Served::Answer(reply) => {
                        let _ = socket.send_to(client_port, &msg.addr, reply).await;
                    }
                    Served::Silent => {}
                    Served::Raises => {
                        // The exception escapes into `process()`'s outer
                        // handler; everything still queued waits a tick.
                        counters.drain_aborts.fetch_add(1, Ordering::Relaxed);
                        carried.extend(drained);
                        break;
                    }
                }
            }
        }
    });
}

struct Rig {
    query: Arc<LiveQuery>,
    counters: Arc<Counters>,
}

async fn rig(set: Set) -> Rig {
    let live = Arc::new(OscSocket::bind_to(0, 0).await.unwrap());
    let live_port = live.local_port();
    let app = Arc::new(OscSocket::bind_to(0, live_port).await.unwrap());
    let app_port = app.local_port();
    let table = Arc::new(Mutex::new(RequestTable::new()));

    // Stands in for lib.rs's receive loop: the only part a tool depends on
    // is that every inbound datagram reaches RequestTable::resolve.
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

    let counters = Arc::new(Counters::default());
    spawn_fake_live(live, app_port, set, counters.clone());
    Rig { query: Arc::new(LiveQuery::new(app, table)), counters }
}

/// Device 0 at the top level -- the shape `get_device_chains` hands the
/// model for a device that is not inside a Rack.
fn device_path() -> DevicePath {
    DevicePath::parse(Some(&serde_json::json!([0]))).expect("[0] is a valid device path")
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .worker_threads(2)
        .build()
        .unwrap()
}

/// Fingerprint, device page, then fingerprint per track. Tracks run
/// concurrently, so this four-device fixture should cost three ticks
/// regardless of track count. A slope means the fan-out broke.
fn bench_device_chains(c: &mut Criterion) {
    let rt = runtime();
    let mut g = c.benchmark_group("round_trips/get_device_chains");
    g.sample_size(20);
    for tracks in [8usize, 40, 128] {
        let r = rt.block_on(rig(Set { tracks, ..Set::default() }));
        let probe = rt.block_on(get_device_chains_range(
            r.query.clone(), 0, tracks as i32, 0, 256, TIMEOUT,
        ));
        assert!(probe.missing.is_empty(), "missing tracks: {:?}", probe.missing);
        assert!(probe.flags_missing.is_empty());
        assert_eq!(probe.tracks.len(), tracks);
        for (index, chain) in probe.tracks.iter().enumerate() {
            assert_eq!(chain.track, index as i32);
            assert_eq!(chain.devices, (0..4).map(|d| format!("«EQ Eight {d}»")).collect::<Vec<_>>());
            assert_eq!(chain.total_devices, 4);
            assert!(!chain.truncated);
            assert_eq!(chain.next_device_offset, None);
        }
        g.bench_with_input(BenchmarkId::from_parameter(tracks), &tracks, |b, &tracks| {
            b.to_async(&rt).iter(|| async {
                black_box(get_device_chains_range(r.query.clone(), 0, tracks as i32, 0, 256, TIMEOUT).await)
            })
        });
        eprintln!(
            "get_device_chains/{tracks}: {} datagrams, {} oversize",
            r.counters.requests.load(Ordering::Relaxed),
            r.counters.dropped_oversize.load(Ordering::Relaxed)
        );
    }
    g.finish();
}

/// Every round trip here is SERIAL: identity, then name_range and
/// value_string_range per window, then the identity re-read.
/// The window count is the only part that grows.
fn bench_device_params(c: &mut Criterion) {
    let rt = runtime();
    let mut g = c.benchmark_group("round_trips/get_device_params");
    g.sample_size(20);
    // 130 = Operator. 256 = MAX_PARAMS, two windows. 512 = a large rack,
    // truncated to MAX_PARAMS but still reporting the real total.
    for params in [130usize, 256, 512] {
        let r = rt.block_on(rig(Set { num_parameters: params, ..Set::default() }));
        let probe = rt.block_on(get_device_params(&r.query, 0, &device_path(), 0, TIMEOUT)).unwrap();
        assert_eq!(probe.missing_reason, None);
        assert_eq!(probe.total, params);
        assert_eq!(probe.params.len(), params.min(256));
        assert_eq!(probe.truncated, params > 256);
        assert_eq!(probe.next_offset, (params > 256).then_some(256));
        for (index, param) in probe.params.iter().enumerate() {
            assert_eq!(param.index, index);
            assert_eq!(param.name, format!("«Oscillator {index} Coarse»"));
            assert_eq!(param.value, format!("«{}.0 Hz»", 100 + index));
        }
        let before = r.counters.requests.load(Ordering::Relaxed);
        g.bench_with_input(BenchmarkId::from_parameter(params), &params, |b, _| {
            b.to_async(&rt)
                .iter(|| async { black_box(get_device_params(&r.query, 0, &device_path(), 0, TIMEOUT).await.unwrap()) })
        });
        eprintln!(
            "get_device_params/{params}: {} datagrams over the run, {} oversize",
            r.counters.requests.load(Ordering::Relaxed) - before,
            r.counters.dropped_oversize.load(Ordering::Relaxed)
        );
    }
    g.finish();
}

/// Sweeps note density against a fixed 128-beat clip.
///
/// One window can hold 358 notes ((MAX_DATAGRAM - 256) / 5 bytes / 5
/// values), so a clip needs ceil(notes / 358) answerable windows and
/// `MAX_WINDOWS` is 16 -- a ceiling of 5,728 notes.
///
/// This sweep is what pins the cost of `/live/clip/get/num_notes`. Without
/// a count, `note_windows(length, 0)` returns ONE window covering the whole
/// clip whatever its density, so the first request for any clip past 358
/// notes was one Live could not answer; the client learned that only by
/// waiting out a full timeout, and every halving step cost another. The
/// fake answers `num_notes`, so what these numbers show is the descent
/// GONE: the silent-probe count is the assertion, and it should be zero at
/// every density.
///
/// `notes` in the report is what the tool actually returned, so a partial
/// read shows up as a coverage figure below 100% with `missing_reason:
/// too_large` -- which is also how a regression in the window arithmetic
/// would surface here.
fn bench_clip_notes(c: &mut Criterion) {
    let rt = runtime();
    let mut g = c.benchmark_group("round_trips/get_clip_notes");
    g.sample_size(10);
    for notes_per_beat in [1usize, 4, 8, 16, DENSE_NOTES_PER_BEAT] {
        let set = Set { notes_per_beat, ..Set::default() };
        let real_notes = set.clip_length_beats as usize * notes_per_beat;
        let r = rt.block_on(rig(set));

        // One profiling call before the timed loop: how much of the clip
        // came back, and how many probes went unanswered getting there.
        let probe = rt.block_on(get_clip_notes(r.query.clone(), 0, 0, TIMEOUT)).unwrap();
        assert_eq!(probe.notes.len(), real_notes);
        assert_eq!(probe.missing_reason, None);
        assert_eq!(probe.source_start_beats, Some(0.0));
        assert!(probe.loop_state_known);
        assert_eq!(probe.loop_region, None);
        let range = probe.note_range.as_ref().unwrap();
        assert_eq!(range.start_beats, 0.0);
        assert_eq!(range.end_beats, 128.0);
        let silent = r.counters.dropped_oversize.load(Ordering::Relaxed);
        assert_eq!(silent, 0);
        eprintln!(
            "get_clip_notes/{notes_per_beat}npb: clip has {real_notes} notes, returned {} \
             ({:.0}%), missing_reason {:?}, {silent} probes answered with silence",
            probe.notes.len(),
            100.0 * probe.notes.len() as f64 / real_notes.max(1) as f64,
            probe.missing_reason,
        );

        g.bench_with_input(
            BenchmarkId::from_parameter(notes_per_beat),
            &notes_per_beat,
            |b, _| {
                b.to_async(&rt)
                    .iter(|| async { black_box(get_clip_notes(r.query.clone(), 0, 0, TIMEOUT).await.unwrap()) })
            },
        );
    }
    g.finish();
}

/// The shape window sizing cannot predict: every note crammed into the
/// front of a long clip, so a window sized for the average density still
/// overflows and has to be halved. The count fixes the COUNT, not the
/// distribution, so this is where halve-and-retry still earns its keep --
/// and where Live's aborted drain bites, since each unanswerable window in
/// a round costs its own tick.
fn bench_clustered_clip_notes(c: &mut Criterion) {
    let rt = runtime();
    let mut g = c.benchmark_group("round_trips/get_clip_notes_clustered");
    g.sample_size(10);
    for cluster in [1.0f32, 0.5, 0.25, 0.125] {
        let set = Set { notes_per_beat: 16, cluster, ..Set::default() };
        let real_notes = set.clip_length_beats as usize * set.notes_per_beat;
        let r = rt.block_on(rig(set));

        let probe = rt.block_on(get_clip_notes(r.query.clone(), 0, 0, TIMEOUT)).unwrap();
        assert_eq!(probe.notes.len(), real_notes);
        assert_eq!(probe.missing_reason, None);
        assert!(probe.loop_state_known);
        eprintln!(
            "get_clip_notes_clustered/{cluster}: {real_notes} notes in the first              {:.0}% of the clip, returned {} ({:.0}%), {} silent probes, {} drain aborts",
            cluster * 100.0,
            probe.notes.len(),
            100.0 * probe.notes.len() as f64 / real_notes.max(1) as f64,
            r.counters.dropped_oversize.load(Ordering::Relaxed),
            r.counters.drain_aborts.load(Ordering::Relaxed),
        );

        g.bench_with_input(
            BenchmarkId::from_parameter(cluster),
            &cluster,
            |b, _| {
                b.to_async(&rt).iter(|| async {
                    black_box(get_clip_notes(r.query.clone(), 0, 0, TIMEOUT).await.unwrap())
                })
            },
        );
    }
    g.finish();
}

criterion_group!(
    benches,
    bench_device_chains,
    bench_device_params,
    bench_clip_notes,
    bench_clustered_clip_notes,
);
criterion_main!(benches);
