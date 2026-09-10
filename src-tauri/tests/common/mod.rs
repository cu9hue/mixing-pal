//! Shared by `evals.rs` (the honesty scenarios) and `craft.rs` (the craft
//! scenarios): a fixture loader, the mirror, a fake Live that answers from
//! a fixture, and the loop that drives one turn against a real provider.
//!
//! Compiled only under `--features evals`, because both binaries that
//! include it are gated on that feature in `Cargo.toml`.
#![allow(dead_code)] // each binary uses a subset

use mixing_pal_lib::eval_api::*;
use rosc::OscType;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Mirrors `MAX_ROUND_TRIPS` in `src/agent/loop.ts`. The eval drives its own
/// loop -- the shipped one is TypeScript and is covered by `loop.test.ts`
/// against a scripted stub -- so this constant is a copy, and a change to
/// the real one will not reach it.
pub const MAX_ROUND_TRIPS: usize = 6;

/// `shared/<name>`, parsed.
pub fn load(name: &str) -> Value {
    let path = format!("{}/../shared/{name}", env!("CARGO_MANIFEST_DIR"));
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path} parses: {e}"))
}

/// `shared/<name>` as a context block, trailing newline removed.
pub fn context(name: &str) -> String {
    let path = format!("{}/../shared/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("{path}: {e}"))
        .trim_end()
        .to_string()
}

pub fn settings() -> Settings {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| panic!("{name} must be set to run the eval suite"))
    };
    Settings {
        base_url: var("MIXINGPAL_EVAL_BASE_URL"),
        model: var("MIXINGPAL_EVAL_MODEL"),
        api_key: var("MIXINGPAL_EVAL_KEY"),
    }
}

/// The same bounds the shipped app uses, from the same constants
/// (`model::MODEL_TIMEOUT`): a provider that accepts the connection and never
/// answers becomes a failed run, not a hung release gate, and the prose
/// round of a craft scenario gets the same room a producer's turn gets.
pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(MODEL_CONNECT_TIMEOUT)
        .timeout(MODEL_TIMEOUT)
        .build()
        .expect("the eval HTTP client configuration is valid")
}

/// The judge's bound: twice the app's, see `judge_client`.
pub const JUDGE_TIMEOUT: Duration = Duration::from_secs(MODEL_TIMEOUT.as_secs() * 2);

/// Twice the app's limit. A judge that reasons before it writes has no
/// producer waiting on it, but it still gets a bound: a provider that
/// never answers must become a failed run, not a hung suite.
pub fn judge_client() -> reqwest::Client {
    reqwest::Client::builder()
        .connect_timeout(MODEL_CONNECT_TIMEOUT)
        .timeout(JUDGE_TIMEOUT)
        .build()
        .expect("the judge HTTP client configuration is valid")
}

/// The mirror the tools read for track count and per-track identity.
pub fn mirror(f: &Value) -> Arc<Mutex<Coalescer>> {
    let mut c = Coalescer::new();
    let tracks = f["tracks"].as_array().unwrap();
    c.observe_delta(Delta {
        addr: "/live/song/get/num_tracks".into(),
        args: vec![json!(tracks.len())],
    });
    // The signature, when the fixture carries one, so the note and
    // arrangement tools render the bar positions production renders.
    for (addr, key) in [
        ("/live/song/get/signature_numerator", "signatureNumerator"),
        ("/live/song/get/signature_denominator", "signatureDenominator"),
    ] {
        if !f["song"][key].is_null() {
            c.observe_delta(Delta { addr: addr.into(), args: vec![f["song"][key].clone()] });
        }
    }
    // Each field is observed only when the fixture carries it: the honesty
    // fixture has no `volume` or `panning`, and `get_track_detail` reports
    // an absent field as absent rather than as a failed read.
    let fields = [
        ("/live/track/get/name", "name"),
        ("/live/track/get/volume", "volume"),
        ("/live/track/get/volume_db", "volumeDb"),
        ("/live/track/get/panning", "panning"),
        ("/live/track/get/mute", "mute"),
        ("/live/track/get/solo", "solo"),
    ];
    for (i, t) in tracks.iter().enumerate() {
        for (addr, key) in fields {
            if t[key].is_null() {
                continue;
            }
            c.observe_delta(Delta {
                addr: addr.into(),
                args: vec![json!(i), t[key].clone()],
            });
        }
    }
    Arc::new(Mutex::new(c))
}

/// True when the slot appears in this track's `clips` array in the fixture,
/// independent of whether the track is MIDI.
///
/// `/live/clip/get/length` is a plain read-only property
/// (`abletonosc/clip.py`'s `properties_r`): the handler just returns
/// `clip.length`, with no branch on clip kind, so Live answers it for an
/// audio clip exactly as it does for a MIDI one. Gating `length` on `midi`
/// too would invent a silence real Live never sends -- exactly the audio-clip
/// case scenario 5 exists to check.
fn slot_is_filled(track: &Value, slot: Option<i32>) -> bool {
    let Some(slot) = slot else { return false };
    track["clips"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["slot"].as_i64() == Some(slot as i64))
}

/// True when the fixture marks this track as MIDI.
///
/// `num_notes` and `notes_window` (`mixingpal/clip_notes.py`) both call
/// `clip.get_notes_extended`. ASSUMED, NOT VERIFIED: that method is
/// MIDI-only and raises for an audio clip, so unlike `length` a filled slot
/// alone is not enough to answer either address -- the track must be MIDI
/// too. The claim comes from reading the connector, not from a run against
/// Live, and `get_notes_extended` is Live's binary API, so nothing in this
/// repo can settle it; only a run against a real set can. If an audio clip
/// does answer these
/// addresses, this gate is wrong and
/// `an_audio_track_is_not_reported_as_having_no_notes` rehearses a case
/// production never produces.
///
/// An empty slot makes `clip` `None` inside the handler regardless of kind,
/// which also raises and answers nothing, so both gates still apply
/// together on these two addresses.
fn clip_is_midi(track: &Value) -> bool {
    track["midi"].as_bool() == Some(true)
}

/// True when arrangement clip `index` appears in this track's `arrangement`
/// array in the fixture -- the arrangement equivalent of `slot_is_filled`.
/// Unlike a session slot, an arrangement index has no gaps: it is a plain
/// position in the array, so existence is just a bounds check.
fn arrangement_clip_exists(track: &Value, index: Option<i32>) -> bool {
    let Some(index) = index else { return false };
    if index < 0 {
        return false;
    }
    track["arrangement"]
        .as_array()
        .map(|a| (index as usize) < a.len())
        .unwrap_or(false)
}

/// A Live that answers from the fixture.
///
/// A device answers `/live/mixingpal/get/device/identity`, the parameter
/// windows, and `/live/mixingpal/get/rack/chains` only when its track's
/// `deviceDetail` describes it. `shared/eval-set.json` describes none, so
/// there `get_rack_contents` (`rack_contents.rs`'s `device_identity`
/// bracket) goes unanswered: the drum scenario asserts the model opens the
/// Rack and then reports a named gap instead of concluding there is no
/// compression. Silence is what an unreadable rack looks like from the
/// client's side, and it costs that scenario one query timeout.
/// `shared/craft-set.json` describes every device, and `craft.rs` checks
/// that it reads in full.
pub async fn fake_live(f: Value) -> Arc<LiveQuery> {
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
        let tracks = f["tracks"].as_array().unwrap().clone();
        let track_at = |i: i32| tracks.get(i as usize).cloned();
        loop {
            let req = match live.recv().await {
                Ok(r) => r,
                Err(_) => continue,
            };
            let int_at = |n: usize| match req.args.get(n) {
                Some(OscType::Int(v)) => Some(*v),
                _ => None,
            };
            let float_at = |n: usize| match req.args.get(n) {
                Some(OscType::Float(v)) => Some(*v),
                Some(OscType::Int(v)) => Some(*v as f32),
                _ => None,
            };
            let str_at = |n: usize| match req.args.get(n) {
                Some(OscType::String(s)) => Some(s.clone()),
                _ => None,
            };
            let Some(track_index) = int_at(0) else {
                continue;
            };
            let Some(track) = track_at(track_index) else {
                continue;
            };
            if track["silent"] == json!(true) {
                continue; // the reply Live could not send
            }
            // A device answers reads only when the fixture describes it.
            // The honesty fixture describes none, so its rack stays
            // unreadable, which its drum scenario depends on.
            let device_detail = || -> Option<(String, Value)> {
                let path = str_at(1)?;
                let detail = track["deviceDetail"].get(path.as_str())?.clone();
                Some((path, detail))
            };

            match req.addr.as_str() {
                "/live/track/get/clips/name" => {
                    let mut reply = vec![OscType::Int(track_index)];
                    let clips = track["clips"].as_array().unwrap();
                    let highest = clips
                        .iter()
                        .map(|c| c["slot"].as_i64().unwrap())
                        .max()
                        .unwrap_or(-1);
                    for slot in 0..=highest {
                        match clips.iter().find(|c| c["slot"].as_i64() == Some(slot)) {
                            Some(c) => {
                                reply.push(OscType::String(c["name"].as_str().unwrap().to_string()))
                            }
                            None => reply.push(OscType::Nil),
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/track/get/has_midi_input" => {
                    let flag = track["midi"].as_bool().unwrap_or(true);
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![OscType::Int(track_index), OscType::Bool(flag)],
                        )
                        .await;
                }
                "/live/track/get/devices/name" => {
                    let mut reply = vec![OscType::Int(track_index)];
                    for d in track["devices"].as_array().unwrap() {
                        reply.push(OscType::String(d.as_str().unwrap().to_string()));
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/track/get/devices/can_have_chains" => {
                    let mut reply = vec![OscType::Int(track_index)];
                    for r in track["racks"].as_array().unwrap() {
                        reply.push(OscType::Bool(r.as_bool().unwrap()));
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/clip/get/length" => {
                    if !slot_is_filled(&track, int_at(1)) {
                        continue; // an unreadable clip gets silence, like real Live
                    }
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Float(4.0),
                            ],
                        )
                        .await;
                }
                "/live/clip/get/num_notes" => {
                    if !(slot_is_filled(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue;
                    }
                    let slot = int_at(1).unwrap_or(0).to_string();
                    let count = track["notes"][&slot]
                        .as_array()
                        .map(|n| n.len())
                        .unwrap_or(0);
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Int(count as i32),
                            ],
                        )
                        .await;
                }
                "/live/clip/get/notes_window" => {
                    if !(slot_is_filled(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue;
                    }
                    let slot = int_at(1).unwrap_or(0).to_string();
                    let (start, span) = (float_at(5).unwrap_or(0.0), float_at(6).unwrap_or(4.0));
                    // (track, clip, window) echoed back, ordinal and all.
                    let mut reply = vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        req.args[2].clone(),
                    ];
                    if let Some(notes) = track["notes"][&slot].as_array() {
                        for n in notes {
                            let at = n["start"].as_f64().unwrap() as f32;
                            if at >= start && at < start + span {
                                reply.extend(vec![
                                    OscType::Int(n["pitch"].as_i64().unwrap() as i32),
                                    OscType::Float(at),
                                    OscType::Float(0.5),
                                    OscType::Float(100.0),
                                    OscType::Bool(false),
                                ]);
                            }
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/mixingpal/get/clip/loop_region" => {
                    if !(slot_is_filled(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue; // an unreadable clip gets silence, like real Live
                    }
                    let slot = int_at(1).unwrap_or(0) as i64;
                    let clip = track["clips"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|c| c["slot"].as_i64() == Some(slot))
                        .unwrap();
                    let mut reply = vec![req.args[0].clone(), req.args[1].clone()];
                    match clip["loop"].as_array() {
                        Some(l) => {
                            reply.push(OscType::Bool(true));
                            reply.push(OscType::Float(l[0].as_f64().unwrap() as f32));
                            reply.push(OscType::Float(l[1].as_f64().unwrap() as f32));
                        }
                        None => {
                            reply.push(OscType::Bool(false));
                            reply.push(OscType::Float(0.0));
                            reply.push(OscType::Float(0.0));
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/mixingpal/get/arrangement" => {
                    let start = int_at(1).unwrap_or(0) as usize;
                    let span = int_at(2).unwrap_or(48) as usize;
                    let clips = track["arrangement"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::Int(start as i32),
                        OscType::Int(clips.len() as i32),
                    ];
                    for clip in clips.iter().skip(start).take(span) {
                        reply.push(OscType::String(clip["name"].as_str().unwrap().to_string()));
                        let start_beats = clip["start"].as_f64().unwrap();
                        reply.push(OscType::Float(start_beats as f32));
                        // Wire 8: the record carries the clip's END time, not
                        // its length. The fixture keeps `length` because that
                        // is what a person writing a fixture thinks in.
                        reply.push(OscType::Float(
                            (start_beats + clip["length"].as_f64().unwrap()) as f32,
                        ));
                        // Wire 9 adds the placement's own mute and MIDI
                        // type before its loop metadata.
                        reply.push(OscType::Bool(false));
                        reply.push(OscType::Bool(true));
                        match clip["loop"].as_array() {
                            Some(l) => {
                                reply.push(OscType::Bool(true));
                                reply.push(OscType::Float(l[0].as_f64().unwrap() as f32));
                                reply.push(OscType::Float(l[1].as_f64().unwrap() as f32));
                            }
                            None => {
                                reply.push(OscType::Bool(false));
                                reply.push(OscType::Float(0.0));
                                reply.push(OscType::Float(0.0));
                            }
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/mixingpal/get/arrangement/identity" => {
                    // The bracket `get_arrangement_notes` opens and closes
                    // around the note read. Its own address, not a span-1
                    // page of the map: the map is keyed on (track, start),
                    // so at index == start the two requests collide.
                    if !arrangement_clip_exists(&track, int_at(1)) {
                        continue; // an unreadable clip gets silence, like real Live
                    }
                    let clip = &track["arrangement"][int_at(1).unwrap() as usize];
                    let start_beats = clip["start"].as_f64().unwrap();
                    let mut reply = vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        OscType::String(clip["name"].as_str().unwrap().to_string()),
                        OscType::Float(start_beats as f32),
                        // Wire 8: end time, not length. See the map arm above.
                        OscType::Float((start_beats + clip["length"].as_f64().unwrap()) as f32),
                    ];
                    reply.push(OscType::Bool(false));
                    reply.push(OscType::Bool(true));
                    // `decode_identity` reads looping, then loop_start and
                    // loop_end only when it is true.
                    match clip["loop"].as_array() {
                        Some(l) => {
                            reply.push(OscType::Bool(true));
                            reply.push(OscType::Float(l[0].as_f64().unwrap() as f32));
                            reply.push(OscType::Float(l[1].as_f64().unwrap() as f32));
                        }
                        None => reply.push(OscType::Bool(false)),
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/arrangement_clip/get/length" => {
                    if !arrangement_clip_exists(&track, int_at(1)) {
                        continue; // an unreadable clip gets silence, like real Live
                    }
                    let clip = &track["arrangement"][int_at(1).unwrap() as usize];
                    let length = clip["length"].as_f64().unwrap() as f32;
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Float(length),
                            ],
                        )
                        .await;
                }
                "/live/arrangement_clip/get/num_notes" => {
                    if !(arrangement_clip_exists(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue;
                    }
                    let index = int_at(1).unwrap_or(0).to_string();
                    let count = track["arrangementNotes"][&index]
                        .as_array()
                        .map(|n| n.len())
                        .unwrap_or(0);
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Int(count as i32),
                            ],
                        )
                        .await;
                }
                "/live/arrangement_clip/get/notes_window" => {
                    if !(arrangement_clip_exists(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue;
                    }
                    let index = int_at(1).unwrap_or(0).to_string();
                    let (start, span) = (float_at(5).unwrap_or(0.0), float_at(6).unwrap_or(4.0));
                    // (track, clip, window) echoed back, ordinal and all.
                    let mut reply = vec![
                        req.args[0].clone(),
                        req.args[1].clone(),
                        req.args[2].clone(),
                    ];
                    if let Some(notes) = track["arrangementNotes"][&index].as_array() {
                        for n in notes {
                            let at = n["start"].as_f64().unwrap() as f32;
                            if at >= start && at < start + span {
                                reply.extend(vec![
                                    OscType::Int(n["pitch"].as_i64().unwrap() as i32),
                                    OscType::Float(at),
                                    OscType::Float(0.5),
                                    OscType::Float(100.0),
                                    OscType::Bool(false),
                                ]);
                            }
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/mixingpal/get/device/identity" => {
                    let Some((path, detail)) = device_detail() else {
                        continue;
                    };
                    let index: usize = path.parse().unwrap_or(usize::MAX);
                    let Some(name) = track["devices"].get(index).and_then(Value::as_str) else {
                        continue;
                    };
                    let total = detail["params"].as_array().map(|p| p.len()).unwrap_or(0);
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                OscType::Int(track_index),
                                OscType::String(path),
                                OscType::String(name.to_string()),
                                OscType::Int(total as i32),
                            ],
                        )
                        .await;
                }
                addr @ ("/live/device/get/parameters/name_range"
                | "/live/device/get/parameters/value_string_range") => {
                    let Some((path, detail)) = device_detail() else {
                        continue;
                    };
                    let start = int_at(2).unwrap_or(0).max(0) as usize;
                    let span = int_at(3).unwrap_or(0).max(0) as usize;
                    let column = if addr.ends_with("name_range") { 0 } else { 1 };
                    let params = detail["params"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::String(path),
                        OscType::Int(start as i32),
                    ];
                    for p in params.iter().skip(start).take(span) {
                        reply.push(OscType::String(p[column].as_str().unwrap().to_string()));
                    }
                    let _ = live.send_to(app_port, addr, reply).await;
                }
                "/live/mixingpal/get/rack/chains" => {
                    // `(track, path, start, total_chains, can_have_chains, *records)`,
                    // each record `name, note, mute, solo, sample_name,
                    // total_devices, reported_devices, *(name, is_rack)` --
                    // the shape `rack_contents::decode_window` reads. The
                    // fixture names no samples and nests no racks.
                    let Some((path, detail)) = device_detail() else {
                        continue;
                    };
                    let index: usize = path.parse().unwrap_or(usize::MAX);
                    let is_rack = track["racks"]
                        .get(index)
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let start = int_at(2).unwrap_or(0).max(0) as usize;
                    let span = int_at(3).unwrap_or(0).max(0) as usize;
                    let chains = detail["chains"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::String(path),
                        OscType::Int(start as i32),
                        OscType::Int(chains.len() as i32),
                        OscType::Int(is_rack as i32),
                    ];
                    for c in chains.iter().skip(start).take(span) {
                        let devices = c["devices"].as_array().cloned().unwrap_or_default();
                        reply.push(OscType::String(c["name"].as_str().unwrap().to_string()));
                        reply.push(OscType::Int(c["note"].as_i64().unwrap_or(-1) as i32));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Nil);
                        reply.push(OscType::Int(devices.len() as i32));
                        reply.push(OscType::Int(devices.len() as i32));
                        for d in &devices {
                            reply.push(OscType::String(d.as_str().unwrap().to_string()));
                            reply.push(OscType::Int(0));
                        }
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                _ => {} // an address the fixture cannot answer
            }
        }
    });

    Arc::new(LiveQuery::new(app, table))
}

/// One tool call the loop made, with what it was asked and whether Live
/// answered. `Turn::called` keeps the bare names for the honesty suite's
/// order assertions; this is the record the craft suite grounds on.
pub struct ToolCallRecord {
    pub name: String,
    pub args: Value,
    /// The result's `missing_reason`, `None` when the read came back whole.
    pub missing_reason: Option<String>,
}

/// What the card shows: the answer with every fenced `note` block removed,
/// the way `noteDelta` in src/notes/note.ts strips it before she reads it.
/// The judge and the wording assertions must score what she sees; the block
/// is the model's bookkeeping, not part of the answer.
pub fn strip_note_blocks(answer: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_block = false;
    for line in answer.lines() {
        let t = line.trim();
        if !in_block && t == "```note" {
            in_block = true;
            continue;
        }
        if in_block {
            if t == "```" {
                in_block = false;
            }
            continue;
        }
        out.push(line);
    }
    out.join("\n").trim().to_string()
}

#[test]
fn stripping_the_note_block_leaves_what_she_reads() {
    let raw = "Try a high-pass.\n\n```note\n+ move low end: high-pass the pad\n```";
    assert_eq!(strip_note_blocks(raw), "Try a high-pass.");
    assert_eq!(strip_note_blocks("No block here."), "No block here.");
    assert_eq!(strip_note_blocks("```note\n+ move a\n```"), "");
}

pub struct Turn {
    pub answer: String,
    pub called: Vec<String>,
    pub calls: Vec<ToolCallRecord>,
    /// Set when the loop exhausted `MAX_ROUND_TRIPS` without a final answer.
    /// Mirrors `runTurn`'s own `truncated` flag in `src/agent/loop.ts`: a
    /// scenario that ran out of steps answered nothing, and an assertion
    /// that checks only tool calls or wording would otherwise read that
    /// exhaustion as success -- including the empty string it returns
    /// satisfying a "does not contain X" check for free.
    pub truncated: bool,
    /// Set when the provider call itself failed (`complete` returned `Err`),
    /// rather than the model answering. `answer` is empty and `called` holds
    /// whatever tool calls happened before the failure.
    pub error: Option<String>,
    /// Wall-clock milliseconds of each provider round trip, in order, the
    /// last one included when it failed. The latency target reads these;
    /// the honesty and craft suites ignore them.
    pub round_trip_ms: Vec<u64>,
}

impl Turn {
    pub fn called_before(&self, first: &str, second: &str) -> bool {
        match (
            self.called.iter().position(|c| c == first),
            self.called.iter().position(|c| c == second),
        ) {
            (Some(a), Some(b)) => a < b,
            _ => false,
        }
    }

    pub fn total_ms(&self) -> u64 {
        self.round_trip_ms.iter().sum()
    }
}

/// `ask_with` at the harness settings and the app's own sampling.
pub async fn ask(f: Value, context: &str, question: &str) -> Turn {
    ask_with(&settings(), None, f, context, question).await
}

/// One question through the same loop the app runs: the tools are answered
/// by the fake Live, and the context block rides ahead of the question as a
/// user turn, exactly as `Conversation.tsx` sends it. A `temperature` is
/// added to every request when given; the app itself sends none, so `None`
/// is what the producer gets and `Some(0.0)` is the goal gate's pin. Built
/// on `build_body` and `complete_with_body`, the two halves of `complete`,
/// so the body is the app's body plus at most that one field.
pub async fn ask_with(
    s: &Settings,
    temperature: Option<f64>,
    f: Value,
    context: &str,
    question: &str,
) -> Turn {
    let ctx = ToolContext {
        coalescer: mirror(&f),
        query: Arc::new(Mutex::new(Some(fake_live(f).await))),
    };
    let http = client();

    let mut messages = vec![ChatMessage {
        role: "user".into(),
        content: Some(format!("{context}\n\n---\n\n{question}")),
        tool_calls: None,
        tool_call_id: None,
    }];
    let mut called: Vec<String> = Vec::new();
    let mut calls: Vec<ToolCallRecord> = Vec::new();
    let mut round_trip_ms: Vec<u64> = Vec::new();

    for _ in 0..MAX_ROUND_TRIPS {
        let started = std::time::Instant::now();
        let completion = match build_body(s, &messages) {
            Ok(mut body) => {
                if let Some(t) = temperature {
                    body["temperature"] = json!(t);
                }
                complete_with_body(&http, s, body).await
            }
            Err(e) => Err(e),
        };
        round_trip_ms.push(started.elapsed().as_millis() as u64);
        let completion = match completion {
            Ok(c) => c,
            Err(e) => {
                return Turn {
                    answer: String::new(),
                    called,
                    calls,
                    truncated: false,
                    error: Some(e),
                    round_trip_ms,
                };
            }
        };
        if completion.tool_calls.is_empty() {
            return Turn {
                answer: strip_note_blocks(&completion.text),
                called,
                calls,
                truncated: false,
                error: None,
                round_trip_ms,
            };
        }
        messages.push(ChatMessage {
            role: "assistant".into(),
            content: (!completion.text.is_empty()).then(|| completion.text.clone()),
            tool_calls: Some(completion.tool_calls.clone()),
            tool_call_id: None,
        });
        for call in &completion.tool_calls {
            called.push(call.function.name.clone());
            let args: Value = serde_json::from_str(&call.function.arguments).unwrap_or(json!({}));
            let result: ToolResult = execute(&ctx, &call.function.name, &args).await;
            let missing_reason = serde_json::to_value(&result)
                .ok()
                .and_then(|v| v["missing_reason"].as_str().map(str::to_string));
            calls.push(ToolCallRecord {
                name: call.function.name.clone(),
                args: args.clone(),
                missing_reason,
            });
            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(serde_json::to_string(&result).unwrap()),
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
            });
        }
    }
    Turn {
        answer: String::new(),
        called,
        calls,
        truncated: true,
        error: None,
        round_trip_ms,
    }
}
