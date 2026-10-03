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

/// The level `ask` runs at: MIXINGPAL_EVAL_EXPERIENCE, named as the app
/// stores it (e.g. new_to_live), or the app's default when unset.
pub fn experience() -> Experience {
    match std::env::var("MIXINGPAL_EVAL_EXPERIENCE") {
        Ok(name) => serde_json::from_value(json!(name))
            .unwrap_or_else(|_| panic!("MIXINGPAL_EVAL_EXPERIENCE={name} is not a level")),
        Err(_) => Experience::default(),
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

/// Live's `Device.type` for a fixture device, from its name: the fixtures
/// name devices by their Live class.
fn device_kind(name: &str) -> i32 {
    match name {
        "Drum Rack" | "Instrument Rack" | "Operator" | "Sampler" | "Simpler" | "Wavetable" => 1,
        "Scale" | "Chord" | "Arpeggiator" => 4,
        _ => 2,
    }
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
    fake_live_recording(f, Arc::new(Mutex::new(Vec::new()))).await
}

/// Record received addresses to check transport work through the real tools.
pub async fn fake_live_recording(f: Value, requests: Arc<Mutex<Vec<String>>>) -> Arc<LiveQuery> {
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
            requests.lock().unwrap().push(req.addr.clone());
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
            // The fixtures have no return tracks; the master holds no devices.
            match req.addr.as_str() {
                "/live/return/get/num_returns" => {
                    let _ = live.send_to(app_port, &req.addr, vec![OscType::Int(0)]).await;
                    continue;
                }
                "/live/mixingpal/get/master_mixer" => {
                    let reply = vec![
                        OscType::String("Main".into()), OscType::String("0.0 dB".into()), OscType::Int(0),
                        OscType::String("C".into()), OscType::Int(0), OscType::Int(0),
                    ];
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                    continue;
                }
                _ => {}
            }
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
                "/live/mixingpal/get/session/clips" => {
                    let start = int_at(1).unwrap_or(0).max(0) as i64;
                    let limit = int_at(2).unwrap_or(16).clamp(1, 16) as i64;
                    let clips = track["clips"].as_array().unwrap();
                    let total = clips.iter().map(|c| c["slot"].as_i64().unwrap() + 1).max().unwrap_or(0);
                    let mut reply = vec![OscType::Int(track_index), OscType::Int(start as i32), OscType::Int(total as i32)];
                    for slot in start..(start + limit).min(total) {
                        reply.push(match clips.iter().find(|c| c["slot"].as_i64() == Some(slot)) {
                            Some(c) => OscType::String(c["name"].as_str().unwrap().chars().take(120).collect()),
                            None => OscType::Nil,
                        });
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
                "/live/mixingpal/get/session/fingerprint" | "/live/mixingpal/get/device_chain/fingerprint" => {
                    use std::hash::{Hash, Hasher};
                    let session = req.addr.contains("/session/");
                    let entries = &track[if session { "clips" } else { "devices" }];
                    let total = if session {
                        entries.as_array().unwrap().iter().map(|c| c["slot"].as_i64().unwrap() + 1).max().unwrap_or(0)
                    } else { entries.as_array().unwrap().len() as i64 };
                    let mut hash = std::collections::hash_map::DefaultHasher::new();
                    entries.to_string().hash(&mut hash);
                    let digest = format!("{:064x}", hash.finish());
                    let _ = live.send_to(app_port, &req.addr, vec![OscType::Int(track_index), OscType::Int(total as i32), OscType::String(digest)]).await;
                }
                "/live/mixingpal/get/device_chain" => {
                    let start = int_at(1).unwrap_or(0).max(0) as usize;
                    let span = int_at(2).unwrap_or(16).clamp(1, 16) as usize;
                    let devices = track["devices"].as_array().unwrap();
                    let mut reply = vec![OscType::Int(track_index), OscType::Int(start as i32), OscType::Int(devices.len() as i32)];
                    for (index, device) in devices.iter().enumerate().skip(start).take(span.min(16)) {
                        let name = device.as_str().unwrap().to_string();
                        reply.push(OscType::String(name.clone()));
                        reply.push(OscType::Bool(track["racks"][index].as_bool().unwrap_or(false)));
                        reply.push(OscType::Bool(true));
                        reply.push(OscType::Int(device_kind(&name)));
                        reply.push(OscType::String(name));
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
                "/live/mixingpal/get/track_mixer" => {
                    let volume = track["volumeDb"].as_str().unwrap_or("0.0 dB").to_string();
                    let reply = vec![
                        OscType::Int(track_index), OscType::String(volume), OscType::Int(0),
                        OscType::String("C".into()), OscType::Int(0), OscType::String("Main".into()),
                        OscType::Int(-1), OscType::Int(0),
                    ];
                    let _ = live.send_to(app_port, &req.addr, reply).await;
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
                    let slot_index = int_at(1).unwrap_or(-1) as i64;
                    let total = track["clips"].as_array().unwrap().iter()
                        .map(|c| c["slot"].as_i64().unwrap() + 1).max().unwrap_or(0);
                    if slot_index < 0 || slot_index >= total { continue; }
                    let status = if !slot_is_filled(&track, int_at(1)) {
                        Some("empty_slot")
                    } else if !clip_is_midi(&track) {
                        Some("not_midi_clip")
                    } else { None };
                    if let Some(status) = status {
                        let _ = live.send_to(app_port, &req.addr, vec![req.args[0].clone(), req.args[1].clone(), OscType::String(status.into())]).await;
                        continue;
                    }
                    let slot = int_at(1).unwrap_or(0).to_string();
                    let count = track["notes"][&slot]
                        .as_array()
                        .map(|n| n.len())
                        .unwrap_or(0);
                    let clip = track["clips"].as_array().unwrap().iter()
                        .find(|c| c["slot"].as_i64() == Some(slot_index)).unwrap();
                    let region = clip["loop"].as_array();
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Int(count as i32),
                                OscType::String("a".repeat(64)),
                                OscType::Float(4.0),
                                OscType::Bool(region.is_some()),
                                OscType::Float(region.map(|r| r[0].as_f64().unwrap() as f32).unwrap_or(0.0)),
                                OscType::Float(region.map(|r| r[1].as_f64().unwrap() as f32).unwrap_or(0.0)),
                                OscType::Float(clip["sourceStart"].as_f64().unwrap_or(0.0) as f32),
                                OscType::Float(clip["sourceEnd"].as_f64().unwrap_or(4.0) as f32),
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
                        reply.push(OscType::Bool(clip_is_midi(&track)));
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
                    reply.push(OscType::Bool(clip_is_midi(&track)));
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
                    let clip = &track["arrangement"][int_at(1).unwrap() as usize];
                    let region = clip["loop"].as_array();
                    let length = clip["length"].as_f64().unwrap();
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::Int(count as i32),
                                OscType::String("a".repeat(64)),
                                OscType::Float(length as f32),
                                OscType::Bool(region.is_some()),
                                OscType::Float(region.map(|r| r[0].as_f64().unwrap() as f32).unwrap_or(0.0)),
                                OscType::Float(region.map(|r| r[1].as_f64().unwrap() as f32).unwrap_or(0.0)),
                                OscType::Float(clip["sourceStart"].as_f64().unwrap_or(0.0) as f32),
                                OscType::Float(clip["sourceEnd"].as_f64().unwrap_or(length) as f32),
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
                "/live/mixingpal/get/rack/fingerprint" => {
                    let Some((path, detail)) = device_detail() else { continue; };
                    let total = detail["chains"].as_array().map_or(0, Vec::len);
                    let _ = live.send_to(app_port, &req.addr, vec![
                        OscType::Int(track_index), OscType::String(path),
                        OscType::Int(total as i32), OscType::String("a".repeat(64)),
                    ]).await;
                }
                "/live/mixingpal/get/arrangement/fingerprint" => {
                    let total = track["arrangement"].as_array().map_or(0, Vec::len);
                    let _ = live.send_to(app_port, &req.addr, vec![
                        OscType::Int(track_index), OscType::Int(total as i32), OscType::String("a".repeat(64)),
                    ]).await;
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
                addr @ "/live/device/get/parameters/automation_state_range" => {
                    let Some((path, detail)) = device_detail() else {
                        continue;
                    };
                    let start = int_at(2).unwrap_or(0).max(0) as usize;
                    let span = int_at(3).unwrap_or(0).max(0) as usize;
                    let params = detail["params"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![OscType::Int(track_index), OscType::String(path), OscType::Int(start as i32)];
                    // A fixture parameter's optional third field is its automation state.
                    for p in params.iter().skip(start).take(span) {
                        reply.push(OscType::Int(p.get(2).and_then(Value::as_i64).unwrap_or(0) as i32));
                    }
                    let _ = live.send_to(app_port, addr, reply).await;
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
                "/live/mixingpal/get/rack/chains" | "/live/mixingpal/get/rack/chains_range" => {
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
                    let ranged = req.addr.ends_with("chains_range");
                    let device_offset = if ranged { int_at(3).unwrap_or(0).max(0) as usize } else { 0 };
                    let span = int_at(if ranged { 4 } else { 3 }).unwrap_or(0).max(0) as usize;
                    let chains = detail["chains"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::String(path),
                        OscType::Int(start as i32),
                    ];
                    if ranged { reply.push(OscType::Int(device_offset as i32)); }
                    reply.push(OscType::Int(chains.len() as i32));
                    reply.push(OscType::Int(is_rack as i32));
                    for c in chains.iter().skip(start).take(span) {
                        let devices = c["devices"].as_array().cloned().unwrap_or_default();
                        reply.push(OscType::String(c["name"].as_str().unwrap().to_string()));
                        reply.push(OscType::Int(c["note"].as_i64().unwrap_or(-1) as i32));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Int(0));
                        reply.push(OscType::Nil);
                        reply.push(OscType::Int(devices.len() as i32));
                        let reported = devices.len().saturating_sub(device_offset).min(32);
                        reply.push(OscType::Int(reported as i32));
                        for d in devices.iter().skip(device_offset).take(reported) {
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
#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct ToolCallRecord {
    pub name: String,
    pub args: Value,
    /// The result's `missing_reason`, `None` when the read came back whole.
    pub missing_reason: Option<String>,
    pub result: Value,
    pub result_truncated: bool,
}

const TOOL_RESULT_BYTES: usize = 32 * 1024;

impl ToolCallRecord {
    pub fn new(name: String, args: Value, result: Value) -> Self {
        let missing_reason = result["missing_reason"].as_str().map(str::to_string);
        let raw = result.to_string();
        let result_truncated = raw.len() > TOOL_RESULT_BYTES;
        let result = if result_truncated {
            // Leave room for escaping the JSON prefix inside a JSON string.
            let mut end = TOOL_RESULT_BYTES / 4;
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            json!({ "json_prefix": &raw[..end], "original_bytes": raw.len() })
        } else {
            result
        };
        Self { name, args, missing_reason, result, result_truncated }
    }
}

#[test]
fn tool_evidence_is_bounded_and_marks_the_missing_tail() {
    let result = json!({ "value": "🎹\"".repeat(TOOL_RESULT_BYTES), "missing_reason": "partial" });
    let record = ToolCallRecord::new("read".into(), json!({}), result);
    assert!(record.result_truncated);
    assert!(record.result.to_string().len() <= TOOL_RESULT_BYTES);
    assert_eq!(record.missing_reason.as_deref(), Some("partial"));
    assert!(record.result["json_prefix"].as_str().unwrap().contains("🎹"));
}

/// What the card shows: the answer with every fenced `note` block removed,
/// the way `noteDelta` in src/notes/note.ts strips it before she reads it.
/// The judge and the wording assertions must score what she sees; the block
/// is the model's bookkeeping, not part of the answer.
pub fn strip_note_blocks(answer: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut block_start = None;
    for line in answer.lines() {
        let t = line.trim();
        if block_start.is_none() && t == "```note" {
            block_start = Some(out.len());
        } else if t == "```" {
            if let Some(start) = block_start.take() {
                out.truncate(start);
                continue;
            }
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
    let unclosed = "Keep it.\n```note\n+ decided keep";
    assert_eq!(strip_note_blocks(unclosed), unclosed);
    let bare = "Keep it.\n```\nnote\n+ move try it\n```";
    assert_eq!(strip_note_blocks(bare), bare);
    assert_eq!(strip_note_blocks("Keep it.\r\n```note\r\n+ decided keep\r\n```"), "Keep it.");
}

#[derive(Debug, Default, PartialEq)]
pub struct NoteDefects {
    pub malformed_blocks: usize,
    pub outcome_placeholders: usize,
}

/// Mechanical note defects only; whether an outcome happened needs review.
pub fn note_defects(raw: &str) -> NoteDefects {
    let mut defects = NoteDefects::default();
    let mut fence: Option<bool> = None;
    let mut has_note_lines = false;
    for line in raw.lines() {
        let text = line.trim();
        if text.starts_with("```") {
            if let Some(valid) = fence.take() {
                if has_note_lines && !valid {
                    defects.malformed_blocks += 1;
                }
            } else {
                fence = Some(text == "```note");
                has_note_lines = false;
            }
            continue;
        }
        let Some(add) = text.strip_prefix("+ ") else { continue };
        let mut words = add.splitn(2, char::is_whitespace);
        let kind = words.next().unwrap_or("").trim_end_matches(':');
        if !matches!(kind, "move" | "heard" | "decided") {
            continue;
        }
        has_note_lines = true;
        if matches!(kind, "heard" | "decided") {
            let outcome = words.next().unwrap_or("").trim().to_lowercase();
            let placeholder = outcome.trim_start_matches(['(', '[']).trim_start();
            if (outcome.contains('<') && outcome.contains('>'))
                || (placeholder != outcome
                    && ["pending", "not yet", "to be filled", "waiting on ", "waiting for "]
                        .iter().any(|p| placeholder.starts_with(p)))
            {
                defects.outcome_placeholders += 1;
            }
        }
    }
    if fence.is_some() && has_note_lines {
        defects.malformed_blocks += 1;
    }
    defects
}

#[test]
fn note_defects_cover_bare_fences_and_hidden_placeholders() {
    for header in ["```", "```\nnote", "```note"] {
        let raw = format!("Keep it.\n{header}\n+ move try bass\n+ heard <to be filled>\n+ decided (pending)\n```");
        assert_eq!(note_defects(&raw), NoteDefects {
            malformed_blocks: usize::from(header != "```note"), outcome_placeholders: 2,
        });
    }
    assert_eq!(note_defects("```note\n+ heard the drop landed\n+ decided keep it\n```"), NoteDefects::default());
    assert_eq!(note_defects("```note\n+ heard not yet muddy at this level\n```"), NoteDefects::default());
    assert_eq!(note_defects("```\nnote\n+ heard [to be filled after trying]\n+ decided [to be filled after trying]\n```"), NoteDefects {
        malformed_blocks: 1, outcome_placeholders: 2,
    });
    assert_eq!(note_defects("```\nnote\n+ heard (waiting on producer)\n+ decided (pending)\n```"), NoteDefects {
        malformed_blocks: 1, outcome_placeholders: 2,
    });
    assert_eq!(note_defects("```rust\nlet pending = true;\n```\nA pending decision."), NoteDefects::default());
    assert_eq!(note_defects("```note\n+ move try bass"), NoteDefects {
        malformed_blocks: 1, outcome_placeholders: 0,
    });
}

pub struct Turn {
    pub answer: String,
    pub raw_answer: String,
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
    /// Wall-clock milliseconds from the start of `ask_with` to its return,
    /// tool execution included. `round_trip_ms` is the provider share of it.
    pub turn_ms: u64,
    /// Provider calls repeated after a transport error. A network fault is
    /// not the model's answer, so it is retried rather than scored.
    pub transport_retries: usize,
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
    ask_with(&settings(), experience(), None, f, context, question).await
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
    experience: Experience,
    temperature: Option<f64>,
    f: Value,
    context: &str,
    question: &str,
) -> Turn {
    ask_after(s, experience, temperature, f, &[], context, question).await
}

/// `ask_with` after earlier turns. `history` is what `Conversation.tsx`
/// keeps: her questions and the answers as plain text, no tool results.
pub async fn ask_after(
    s: &Settings,
    experience: Experience,
    temperature: Option<f64>,
    f: Value,
    history: &[ChatMessage],
    context: &str,
    question: &str,
) -> Turn {
    let turn_started = std::time::Instant::now();
    let ctx = ToolContext {
        coalescer: mirror(&f),
        query: Arc::new(Mutex::new(Some(fake_live(f).await))),
    };
    let http = client();

    let mut messages = history.to_vec();
    messages.push(ChatMessage {
        role: "user".into(),
        content: Some(format!("{context}\n\n---\n\n{question}")),
        tool_calls: None,
        tool_call_id: None,
    });
    let mut called: Vec<String> = Vec::new();
    let mut calls: Vec<ToolCallRecord> = Vec::new();
    let mut round_trip_ms: Vec<u64> = Vec::new();

    let mut transport_retries = 0;
    for _ in 0..MAX_ROUND_TRIPS {
        let (completion, elapsed) = loop {
            let started = std::time::Instant::now();
            let completion = match build_body(s, experience, &messages) {
                Ok(mut body) => {
                    if let Some(t) = temperature {
                        body["temperature"] = json!(t);
                    }
                    route_like_the_proxy(&mut body);
                    complete_with_body(&http, s, body).await
                }
                Err(e) => Err(e),
            };
            match completion {
                Err(e) if is_transport_error(&e) && transport_retries < TRANSPORT_RETRIES => {
                    transport_retries += 1;
                }
                completion => break (completion, started.elapsed()),
            }
        };
        round_trip_ms.push(elapsed.as_millis() as u64);
        let completion = match completion {
            Ok(c) => c,
            Err(e) => {
                return Turn {
                    answer: String::new(),
                    raw_answer: String::new(),
                    called,
                    calls,
                    truncated: false,
                    error: Some(e),
                    round_trip_ms,
                    turn_ms: turn_started.elapsed().as_millis() as u64,
                    transport_retries,
                };
            }
        };
        if completion.tool_calls.is_empty() {
            // A blank answer, kept for replay against the provider to see why.
            if let (true, Ok(dir), Ok(body)) = (
                completion.text.trim().is_empty(),
                std::env::var("MIXINGPAL_EVAL_DUMP"),
                build_body(s, experience, &messages),
            ) {
                let name = format!("{dir}/blank-{}-{}.json", s.model.replace('/', "_"), crate_now_millis());
                let _ = std::fs::write(name, body.to_string());
            }
            return Turn {
                answer: strip_note_blocks(&completion.text),
                raw_answer: completion.text,
                called,
                calls,
                truncated: false,
                error: None,
                round_trip_ms,
                turn_ms: turn_started.elapsed().as_millis() as u64,
                transport_retries,
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
            calls.push(ToolCallRecord::new(
                call.function.name.clone(), args.clone(), serde_json::to_value(&result).unwrap(),
            ));
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
        raw_answer: String::new(),
        called,
        calls,
        truncated: true,
        error: None,
        round_trip_ms,
        turn_ms: turn_started.elapsed().as_millis() as u64,
        transport_retries,
    }
}

/// Mirrors `providerBody` in proxy/src/policy.ts (reasoning off, no-data hosts) so evals
/// score what producers get. A candidate route sets MIXINGPAL_EVAL_PROVIDERS (comma-separated
/// `only`), MIXINGPAL_EVAL_QUANTIZATIONS, MIXINGPAL_EVAL_REASONING=low|medium|high, and
/// MIXINGPAL_EVAL_MAX_TOKENS: reasoning spends from the answer's cap.
pub fn route_like_the_proxy(body: &mut Value) {
    if let Some(cap) = std::env::var("MIXINGPAL_EVAL_MAX_TOKENS").ok().and_then(|v| v.parse::<u64>().ok()) {
        body["max_tokens"] = json!(cap);
    }
    body["reasoning"] = match std::env::var("MIXINGPAL_EVAL_REASONING") {
        Ok(effort) if effort != "off" => json!({ "effort": effort }),
        _ => json!({ "enabled": false }),
    };
    body["provider"] = json!({ "require_parameters": true, "data_collection": "deny", "zdr": true });
    let list = |name: &str| std::env::var(name).ok().map(|v| v.split(',').map(str::trim).map(String::from).collect::<Vec<_>>());
    if let Some(only) = list("MIXINGPAL_EVAL_PROVIDERS") {
        body["provider"]["only"] = json!(only);
    }
    if let Some(quantizations) = list("MIXINGPAL_EVAL_QUANTIZATIONS") {
        body["provider"]["quantizations"] = json!(quantizations);
    }
}

fn crate_now_millis() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

/// Repeats of one provider call after a transport error, before the turn
/// reports it. Two, so a dropped connection costs a retry, not a verdict.
pub const TRANSPORT_RETRIES: usize = 2;

/// A failure of the network or the provider, not an answer from the model.
/// The strings are `model.rs`'s transport errors and status reports.
pub fn is_transport_error(e: &str) -> bool {
    e.contains("could not reach")
        || e.contains("could not read the reply")
        || e.contains("did not answer within")
        || e.contains(" returned 429")
        || e.contains(" returned 5")
}

#[test]
fn transport_errors_are_told_apart_from_answers() {
    assert!(is_transport_error("could not reach https://x/chat/completions: error sending request"));
    assert!(is_transport_error("could not read the reply from https://x: error decoding response body"));
    assert!(is_transport_error("https://x returned 502 Bad Gateway: upstream"));
    assert!(is_transport_error("https://x returned 429 Too Many Requests: slow down"));
    assert!(!is_transport_error("https://x returned 401 Unauthorized: invalid api key"));
    assert!(!is_transport_error("https://x returned 400 Bad Request: no such model"));
}

/// Runs per scenario: MIXINGPAL_EVAL_RUNS, default 5. One run cannot tell a
/// model that passes 70% of the time from one that passes 95%.
pub fn runs() -> usize {
    std::env::var("MIXINGPAL_EVAL_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(5)
}

/// The share of valid runs a scenario must pass to stay green.
pub const MIN_PASS_RATE: f64 = 0.8;

/// Phrases that offer the producer a read instead of making it.
const OFFERS: &[&str] = &[
    "want me to pull", "want me to read", "want me to check", "want me to look",
    "say the word", "say go", "i can pull", "i can check",
    "shall i pull", "shall i read", "let me know if you want me to", "if you'd like me to",
];

/// Why the answer talks tools to the producer, or `None`. Tool names and
/// offers to read are for the model; a pilot answer did both.
pub fn tool_talk(answer: &str) -> Option<String> {
    let a = answer.to_lowercase();
    if a.contains("get_") {
        return Some("names a tool".into());
    }
    OFFERS.iter().find(|o| a.contains(*o)).map(|o| format!("offers a read: {o:?}"))
}

#[test]
fn tool_talk_catches_tool_names_and_offers_only() {
    assert!(tool_talk("call this with get_rack_contents to see").is_some());
    assert!(tool_talk("I can pull the exact knobs if you say go.").is_some());
    assert!(tool_talk("Let me know if you want me to check the rack.").is_some());
    assert!(tool_talk("The hat comes in at bar 3. **Leave it.**").is_none());
}

const JUDGE_PROMPT: &str = "You check one answer from a copilot for music producers \
working in Ableton Live. The copilot read the producer's set with tools; you cannot see \
the set. The properties are the answer key: every fact a property states about the set is \
true. Check the answer against them. A fact in the answer that the property does not \
mention is not an error unless it contradicts the key. Never fail an answer because you \
cannot see the set. Style, length, and tone do not matter. Reply with one JSON object and nothing \
else: {\"<property key>\": {\"reason\": \"<one or two sentences checking the answer against the key>\", \
\"pass\": true or false}}, with every property key. Write the reason first, then the verdict that \
follows from it.";

/// The judge for properties a phrase list cannot decide. The model is
/// MIXINGPAL_JUDGE_MODEL, required, so no candidate grades its own answers.
pub async fn judge(question: &str, answer: &str, properties: &[(&str, &str)]) -> Result<Vec<(String, bool, String)>, String> {
    let model = std::env::var("MIXINGPAL_JUDGE_MODEL")
        .expect("MIXINGPAL_JUDGE_MODEL must be set: a model other than the one under test");
    let s = Settings { model, ..settings() };
    let list = properties.iter().map(|(k, d)| format!("- {k}: {d}")).collect::<Vec<_>>().join("\n");
    let body = json!({
        "model": s.model,
        "temperature": 0,
        "max_tokens": 2000,
        "messages": [
            { "role": "system", "content": JUDGE_PROMPT },
            { "role": "user", "content": format!("QUESTION\n{question}\n\nANSWER\n{answer}\n\nPROPERTIES\n{list}") },
        ],
    });
    let raw = post_chat(&judge_client(), &s, body).await.map_err(|e| format!("judge call failed: {e}"))?;
    let content = raw["choices"][0]["message"]["content"].as_str().unwrap_or("");
    parse_verdicts(content, properties)
}

fn parse_verdicts(content: &str, properties: &[(&str, &str)]) -> Result<Vec<(String, bool, String)>, String> {
    let Some(start) = content.find('{') else {
        return Err(format!("judge returned no JSON: {content:?}"));
    };
    // The first object only: a judge has followed its answer with a second.
    let parsed: Value = serde_json::Deserializer::from_str(&content[start..])
        .into_iter::<Value>()
        .next()
        .ok_or("judge returned no JSON")?
        .map_err(|e| format!("invalid judge JSON: {e}"))?;
    properties
        .iter()
        .map(|(key, _)| {
            let pass = parsed[key]["pass"].as_bool().ok_or(format!("judge left out {key}"))?;
            Ok((key.to_string(), pass, parsed[key]["reason"].as_str().unwrap_or("").to_string()))
        })
        .collect()
}

#[test]
fn judge_verdicts_need_every_key() {
    let props = [("a", "x"), ("b", "y")];
    let ok = parse_verdicts("```json\n{\"a\":{\"pass\":true,\"reason\":\"r\"},\"b\":{\"pass\":false}}\n```", &props).unwrap();
    assert_eq!(ok[1], ("b".to_string(), false, String::new()));
    assert!(parse_verdicts("{\"a\":{\"pass\":true}}", &props).is_err());
    let twice = "{\"a\":{\"pass\":true},\"b\":{\"pass\":true}}\n{\"a\":{\"pass\":false}}";
    assert!(parse_verdicts(twice, &props).unwrap().iter().all(|v| v.1));
    assert!(parse_verdicts("no", &props).is_err());
}

pub enum Verdict {
    Pass,
    Fail(String),
    /// The network or the judge failed; the run says nothing about the model.
    Void(String),
}

/// The checks every scenario shares: the provider answered, the loop ended
/// in an answer, and the answer talks no tools.
pub fn base_verdict(turn: &Turn) -> Option<Verdict> {
    if let Some(e) = &turn.error {
        return Some(if is_transport_error(e) { Verdict::Void(e.clone()) } else { Verdict::Fail(format!("provider error: {e}")) });
    }
    if turn.truncated {
        return Some(Verdict::Fail(format!("ran out of round trips: {:?}", turn.called)));
    }
    if turn.answer.trim().is_empty() {
        return Some(Verdict::Fail("empty answer".into()));
    }
    tool_talk(&turn.answer).map(Verdict::Fail)
}

/// The judge's verdict on `properties`: a failed property fails the run, a
/// failed judge call voids it.
pub async fn judged(question: &str, turn: &Turn, properties: &[(&str, &str)]) -> Verdict {
    match judge(question, &turn.answer, properties).await {
        Err(e) => Verdict::Void(e),
        Ok(verdicts) => match verdicts.iter().find(|(_, pass, _)| !pass) {
            Some((key, _, reason)) => Verdict::Fail(format!("{key}: {reason}")),
            None => Verdict::Pass,
        },
    }
}

/// One scenario's runs as a pass rate. `finish` appends a JSON line to
/// MIXINGPAL_EVAL_REPORT when set, so models compare scenario by scenario.
pub struct Tally {
    scenario: &'static str,
    passes: usize,
    voids: Vec<String>,
    failures: Vec<(String, String, String, Value)>,
    turn_ms: Vec<u64>,
}

impl Tally {
    pub fn new(scenario: &'static str) -> Self {
        Tally { scenario, passes: 0, voids: vec![], failures: vec![], turn_ms: vec![] }
    }

    pub fn add(&mut self, turn: &Turn, verdict: Verdict) {
        self.turn_ms.push(turn.turn_ms);
        match verdict {
            Verdict::Pass => self.passes += 1,
            Verdict::Void(e) => self.voids.push(e),
            Verdict::Fail(reason) => {
                let calls = turn.calls.iter().map(|c| json!([c.name, c.args, c.missing_reason])).collect();
                self.failures.push((reason, turn.answer.clone(), turn.raw_answer.clone(), calls));
            }
        }
    }

    pub fn finish(mut self) {
        self.turn_ms.sort_unstable();
        let median_turn_ms = self.turn_ms.get(self.turn_ms.len() / 2).copied().unwrap_or(0);
        let valid = self.passes + self.failures.len();
        let total = valid + self.voids.len();
        let line = json!({
            "scenario": self.scenario,
            "model": std::env::var("MIXINGPAL_EVAL_MODEL").unwrap_or_default(),
            "experience": format!("{:?}", experience()),
            "passes": self.passes, "valid": valid, "voids": self.voids.len(),
            "median_turn_ms": median_turn_ms,
            "failures": self.failures.iter().map(|(r, a, raw, calls)| json!({"reason": r, "answer": a, "raw_answer": raw, "calls": calls})).collect::<Vec<_>>(),
            "void_reasons": self.voids,
        });
        if let Ok(path) = std::env::var("MIXINGPAL_EVAL_REPORT") {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).unwrap();
            writeln!(f, "{line}").unwrap();
        }
        println!("RATE {} {}/{} passed, {} void", self.scenario, self.passes, valid, self.voids.len());
        assert!(valid * 2 >= total, "too many void runs to judge {}: {:?}", self.scenario, self.voids);
        assert!(
            self.passes as f64 >= MIN_PASS_RATE * valid as f64,
            "{}: {}/{} passed\n{}",
            self.scenario,
            self.passes,
            valid,
            self.failures.iter().map(|(r, a, _, _)| format!("--- {r}\n{a}\n")).collect::<String>()
        );
    }
}
