//! Synthetic benchmarks for every CPU-bound path a tool call or the receive
//! loop can reach.
//!
//! WHY THESE AND NOT OTHERS. Every tool in this app is dominated by OSC
//! round trips: `manager.py`'s `tick` runs `osc_server.process()` once per
//! 100 ms and drains the whole socket inside that tick, so one round trip
//! costs up to 100 ms no matter how small the work is. These benchmarks
//! exist to establish the OTHER side of that ratio -- how much CPU the app
//! spends per call -- so "the round trips dominate" is a measured claim and
//! a regression that makes it stop being true gets caught here.
//!
//! Workload sizes are the real ceilings, not round numbers:
//!   * tracks    8 / 40 / 128 -- Lite's cap, a normal working set, a large one
//!   * notes     100 / 1000 / 5728 -- the last is MAX_WINDOWS times the
//!               per-window note budget, 16 * (1792 / 5) = 16 * 358, the most
//!               `get_clip_notes` can return. The division floors first: 358
//!               notes per datagram, not 358.4.
//!   * params    256 -- `device_params::MAX_PARAMS`, the hard cap on one device
//!
//! Run: cargo bench --features bench

use criterion::{black_box, criterion_group, criterion_main, BenchmarkId, Criterion, Throughput};
use mixing_pal_lib::bench_api::*;
use rosc::{OscMessage, OscType};
use std::time::Instant;

const TRACK_COUNTS: [usize; 3] = [8, 40, 128];
const NOTE_COUNTS: [usize; 3] = [100, 1_000, 5_728];

// ---------------------------------------------------------------- receive loop

/// The mirror write every inbound datagram performs. This is the only path
/// in the app that runs at a fixed rate forever, so it is the one place a
/// per-message cost compounds.
fn track_state_messages(tracks: usize) -> Vec<OscMessage> {
    let addrs = [
        "/live/track/get/name",
        "/live/track/get/mute",
        "/live/track/get/solo",
        "/live/track/get/volume",
        "/live/track/get/panning",
        "/live/track/get/output_meter_level",
    ];
    let mut out = Vec::new();
    for t in 0..tracks as i32 {
        for addr in addrs {
            let value = match addr {
                "/live/track/get/name" => OscType::String(format!("Track {t}")),
                "/live/track/get/mute" | "/live/track/get/solo" => OscType::Bool(t % 3 == 0),
                _ => OscType::Float(0.813_f32),
            };
            out.push(OscMessage {
                addr: addr.to_string(),
                args: vec![OscType::Int(t), value],
            });
        }
    }
    out
}

fn bench_coalescer_observe(c: &mut Criterion) {
    let mut g = c.benchmark_group("coalescer/observe");
    for tracks in TRACK_COUNTS {
        let msgs = track_state_messages(tracks);
        g.throughput(Throughput::Elements(msgs.len() as u64));
        g.bench_with_input(BenchmarkId::from_parameter(tracks), &msgs, |b, msgs| {
            b.iter(|| {
                let mut coalescer = Coalescer::new();
                for m in msgs {
                    coalescer.observe(black_box(m));
                }
                coalescer
            })
        });
    }
    g.finish();
}

/// `drain()` runs every 250 ms in the emit loop; `snapshot()` runs on the
/// MAIN THREAD, because `#[tauri::command] fn snapshot` is synchronous.
fn bench_coalescer_read(c: &mut Criterion) {
    let mut g = c.benchmark_group("coalescer/read");
    for tracks in TRACK_COUNTS {
        let mut coalescer = Coalescer::new();
        for m in track_state_messages(tracks) {
            coalescer.observe(&m);
        }
        g.bench_with_input(
            BenchmarkId::new("snapshot", tracks),
            &coalescer,
            |b, coalescer| b.iter(|| black_box(coalescer.snapshot())),
        );
        g.bench_with_input(
            BenchmarkId::new("drain", tracks),
            &tracks,
            |b, &tracks| {
                let msgs = track_state_messages(tracks);
                b.iter(|| {
                    let mut c = Coalescer::new();
                    for m in &msgs {
                        c.observe(m);
                    }
                    black_box(c.drain())
                })
            },
        );
    }
    g.finish();
}

/// Decoding one bulk reply into per-track deltas, then writing all of them
/// into the mirror -- the single largest slice of work `handle_inbound` can
/// do, and it happens on the same task that owns `recv()`.
fn bench_bulk_decode(c: &mut Criterion) {
    let mut g = c.benchmark_group("bulk/decode");
    for tracks in TRACK_COUNTS {
        let track_args: Vec<OscType> = (0..tracks as i32)
            .flat_map(|t| {
                vec![
                    OscType::String(format!("Track {t}")),
                    OscType::Bool(false),
                    OscType::Bool(false),
                ]
            })
            .collect();
        let mixer_args: Vec<OscType> = (0..tracks)
            .flat_map(|_| {
                vec![
                    OscType::Float(0.85),
                    OscType::Float(-0.2),
                    OscType::String("-3.0 dB".to_string()),
                ]
            })
            .collect();
        let range = (0u32, tracks as u32);

        g.throughput(Throughput::Elements(tracks as u64));
        g.bench_with_input(
            BenchmarkId::new("track_data", tracks),
            &track_args,
            |b, args| b.iter(|| black_box(decode_track_data(range, black_box(args)))),
        );
        g.bench_with_input(
            BenchmarkId::new("mixer_data", tracks),
            &mixer_args,
            |b, args| b.iter(|| black_box(decode_mixer_data(range, black_box(args)))),
        );
        // Decode AND ingest, which is what handle_inbound actually does.
        g.bench_with_input(
            BenchmarkId::new("mixer_data+observe", tracks),
            &mixer_args,
            |b, args| {
                b.iter(|| {
                    let mut c = Coalescer::new();
                    for d in decode_mixer_data(range, black_box(args)) {
                        c.observe_delta(d);
                    }
                    c
                })
            },
        );
    }
    g.finish();
}

fn bench_key_arity(c: &mut Criterion) {
    // A literal 47-arm string match, run once per inbound datagram in
    // `observe` and up to three more times per datagram in `resolve`.
    let addrs = [
        "/live/track/get/output_meter_level",
        "/live/song/get/beat",
        "/live/device/get/parameters/value_string_range",
        "/live/track/get/invented",
    ];
    c.bench_function("arity/key_arity", |b| {
        b.iter(|| {
            for a in addrs {
                black_box(key_arity(black_box(a)));
            }
        })
    });
}

// ---------------------------------------------------------------------- tools

/// `get_track_detail` end to end. The only tool that costs zero OSC traffic,
/// so its wall time IS its CPU time -- the one case where this file measures
/// a whole tool rather than a piece of one.
fn bench_track_detail(c: &mut Criterion) {
    let mut g = c.benchmark_group("tools/get_track_detail");
    for tracks in TRACK_COUNTS {
        let mut coalescer = Coalescer::new();
        for m in track_state_messages(tracks) {
            coalescer.observe(&m);
        }
        let target = (tracks / 2) as u32;
        g.bench_with_input(
            BenchmarkId::from_parameter(tracks),
            &coalescer,
            |b, coalescer| {
                b.iter(|| black_box(get_track_detail(coalescer, black_box(target), Instant::now())))
            },
        );
    }
    g.finish();
}

fn note_reply(count: usize) -> Vec<OscType> {
    // (track, clip, window) echoed back -- see `notes_window`.
    let mut args = vec![OscType::Int(1), OscType::Int(0), OscType::Int(0)];
    for i in 0..count {
        args.extend([
            OscType::Int(36 + (i % 60) as i32),
            // Deliberately not round: `as_f64` widens through f32's
            // shortest-decimal Display, and a value with a long decimal
            // form is the expensive case.
            OscType::Float(i as f32 * 0.127),
            OscType::Float(0.483),
            OscType::Float(101.0),
            OscType::Bool(false),
        ]);
    }
    args
}

/// `decode_notes` plus the merge-and-sort `get_clip_notes` runs afterwards
/// -- the largest CPU cost any tool call in this app can incur.
fn bench_clip_notes(c: &mut Criterion) {
    let mut g = c.benchmark_group("tools/clip_notes");
    for notes in NOTE_COUNTS {
        let reply = note_reply(notes);
        g.throughput(Throughput::Elements(notes as u64));
        g.bench_with_input(BenchmarkId::new("decode", notes), &reply, |b, reply| {
            b.iter(|| black_box(decode_notes(black_box(reply), 0)))
        });
        g.bench_with_input(BenchmarkId::new("decode+sort", notes), &reply, |b, reply| {
            b.iter(|| {
                let mut decoded: Vec<Note> = decode_notes(black_box(reply), 0).unwrap();
                decoded.sort_by(|a, b| {
                    a.start
                        .partial_cmp(&b.start)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then(a.pitch.cmp(&b.pitch))
                });
                decoded
            })
        });
        g.bench_with_input(
            BenchmarkId::new("serialize", notes),
            &reply,
            |b, reply| {
                let decoded = decode_notes(reply, 0).unwrap();
                b.iter(|| black_box(serde_json::to_value(black_box(&decoded)).unwrap()))
            },
        );
    }
    g.finish();
}

/// Every producer- and plugin-controlled string crosses `fence` before it
/// reaches the prompt: up to 512 of them for one 256-parameter device.
fn bench_fence(c: &mut Criterion) {
    let mut g = c.benchmark_group("tools/fence");
    let short = "Bass";
    let long = "Macro 1 – Filter Cutoff «very» long name that runs past the cap".repeat(4);
    g.bench_function("short", |b| b.iter(|| black_box(fence(black_box(short)))));
    g.bench_function("over_cap", |b| b.iter(|| black_box(fence(black_box(&long)))));
    g.bench_function("device_params_worst_case_512", |b| {
        b.iter(|| {
            for _ in 0..512 {
                black_box(fence(black_box(short)));
            }
        })
    });
    g.finish();
}

/// The trace step every `execute_tool` writes. `prepare_value` deep-clones
/// the result, serializes the clone, and counts its chars -- all of it after
/// the tool already answered, and all of it on a tokio worker.
fn bench_trace_push(c: &mut Criterion) {
    let mut g = c.benchmark_group("trace/push");
    for notes in NOTE_COUNTS {
        let decoded = decode_notes(&note_reply(notes), 0).unwrap();
        let result = serde_json::json!({
            "value": { "notes": decoded, "count": decoded.len() },
            "queried_at": 1_700_000_000_000u64,
            "fresh_as_of": 1_700_000_000_000u64,
            "fresh": true,
            "missing_reason": serde_json::Value::Null,
        });
        g.throughput(Throughput::Elements(notes as u64));
        g.bench_with_input(BenchmarkId::from_parameter(notes), &result, |b, result| {
            b.iter(|| {
                let mut t = Trace::new();
                t.push(TraceStep::tool(
                    0,
                    "get_clip_notes".to_string(),
                    serde_json::json!({"track": 1, "clip": 0}),
                    black_box(result.clone()),
                    12,
                    "https://api.example.com/v1",
                ));
                t
            })
        });
    }
    g.finish();
}

// -------------------------------------------------------------- request table

/// Register/resolve for one `get_device_chains` fan-out: `MAX_FANOUT_TRACKS`
/// is 512, so this is the widest the table ever gets, and every one of those
/// operations happens under the same `std::sync::Mutex`.
fn bench_request_table(c: &mut Criterion) {
    let mut g = c.benchmark_group("requests/fanout");
    for tracks in [40usize, 512] {
        g.throughput(Throughput::Elements(tracks as u64));
        g.bench_with_input(BenchmarkId::from_parameter(tracks), &tracks, |b, &tracks| {
            b.iter(|| {
                let mut t = RequestTable::new();
                let now = Instant::now();
                for i in 0..tracks as i32 {
                    t.register(now, "/live/track/get/devices/name", &[OscType::Int(i)]);
                }
                for i in 0..tracks as i32 {
                    t.resolve(&OscMessage {
                        addr: "/live/track/get/devices/name".to_string(),
                        args: vec![OscType::Int(i), OscType::String("EQ Eight".into())],
                    });
                }
                t
            })
        });
    }
    g.finish();
}

/// Pure arithmetic that decides how many round trips a call will cost. Runs
/// once per call, so it can only ever be noise -- measured to prove that,
/// not because it is suspected.
fn bench_budget(c: &mut Criterion) {
    let mut g = c.benchmark_group("budget");
    // Both branches: no estimate is the early return, and a real estimate
    // walks the boundary-differencing path that actually allocates.
    g.bench_function("note_windows/no_estimate", |b| {
        b.iter(|| black_box(note_windows(black_box(256.0), black_box(0))))
    });
    g.bench_function("note_windows/5728_notes", |b| {
        b.iter(|| black_box(note_windows(black_box(256.0), black_box(5_728))))
    });
    g.bench_function("param_string_windows/256", |b| {
        b.iter(|| black_box(param_string_windows(black_box(256))))
    });
    g.bench_function("track_chunks/128", |b| {
        b.iter(|| black_box(track_chunks(black_box(128), 64, 3, 0)))
    });
    g.bench_function("mixer_chunks/128", |b| {
        b.iter(|| black_box(mixer_chunks(black_box(128))))
    });
    g.finish();
}

criterion_group!(
    benches,
    bench_coalescer_observe,
    bench_coalescer_read,
    bench_bulk_decode,
    bench_key_arity,
    bench_track_detail,
    bench_clip_notes,
    bench_fence,
    bench_trace_push,
    bench_request_table,
    bench_budget,
);
criterion_main!(benches);
