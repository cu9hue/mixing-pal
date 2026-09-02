//! Shared by `evals.rs` (the honesty scenarios) and `craft.rs` (the craft
//! scenarios): a fixture loader, the mirror, a fake Live that answers from
//! a fixture, and the loop that drives one turn against a real provider.
//!
//! Compiled only under `--features evals`, because both binaries that
//! include it are gated on that feature in `Cargo.toml`.
#![allow(dead_code)] // each binary uses a subset

use mixing_pal_lib::eval_api::*;
use rosc::OscType;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

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
        std::env::var(name)
            .unwrap_or_else(|_| panic!("{name} must be set to run the eval suite"))
    };
    Settings {
        base_url: var("MIXINGPAL_EVAL_BASE_URL"),
        model: var("MIXINGPAL_EVAL_MODEL"),
        api_key: var("MIXINGPAL_EVAL_KEY"),
    }
}

/// The mirror the tools read for track count and per-track identity.
pub fn mirror(f: &Value) -> Arc<Mutex<Coalescer>> {
    let mut c = Coalescer::new();
    let tracks = f["tracks"].as_array().unwrap();
    c.observe_delta(Delta {
        addr: "/live/song/get/num_tracks".into(),
        args: vec![json!(tracks.len())],
    });
    for (i, t) in tracks.iter().enumerate() {
        c.observe_delta(Delta {
            addr: "/live/track/get/name".into(),
            args: vec![json!(i), t["name"].clone()],
        });
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
    track["clips"].as_array().unwrap().iter().any(|c| c["slot"].as_i64() == Some(slot as i64))
}

/// True when the fixture marks this track as MIDI.
///
/// `num_notes` and `notes_window` (`mixingpal/clip_notes.py`) both call
/// `clip.get_notes_extended`. ASSUMED, NOT VERIFIED: that method is
/// MIDI-only and raises for an audio clip, so unlike `length` a filled slot
/// alone is not enough to answer either address -- the track must be MIDI
/// too. The claim comes from reading the connector, not from a run against
/// Live, and `get_notes_extended` is Live's binary API, so nothing in this
/// repo can settle it. The Clips checklist in `docs/manual-verification.md`
/// is where it gets confirmed. If an audio clip does answer these
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
    track["arrangement"].as_array().map(|a| (index as usize) < a.len()).unwrap_or(false)
}

/// A Live that answers from the fixture.
///
/// It deliberately does NOT answer `/live/mixingpal/get/device/identity`,
/// the address `get_rack_contents` queries first (`rack_contents.rs`'s
/// `device_identity` bracket, via `device_params::device_identity`): the
/// drum scenario asserts the model opens the Rack and then reports a named
/// gap instead of concluding there is no compression. Silence is what an
/// unreadable rack looks like from the client's side, and it costs that
/// scenario one query timeout.
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
            let Some(track_index) = int_at(0) else { continue };
            let Some(track) = track_at(track_index) else { continue };
            if track["silent"] == json!(true) {
                continue; // the reply Live could not send
            }

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
                            Some(c) => reply
                                .push(OscType::String(c["name"].as_str().unwrap().to_string())),
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
                    let count = track["notes"][&slot].as_array().map(|n| n.len()).unwrap_or(0);
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
                        reply.push(OscType::String(
                            clip["name"].as_str().unwrap().to_string(),
                        ));
                        reply.push(OscType::Float(clip["start"].as_f64().unwrap() as f32));
                        reply.push(OscType::Float(clip["length"].as_f64().unwrap() as f32));
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
                    let _ = live
                        .send_to(
                            app_port,
                            &req.addr,
                            vec![
                                req.args[0].clone(),
                                req.args[1].clone(),
                                OscType::String(clip["name"].as_str().unwrap().to_string()),
                                OscType::Float(clip["start"].as_f64().unwrap() as f32),
                                OscType::Float(clip["length"].as_f64().unwrap() as f32),
                            ],
                        )
                        .await;
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
                            vec![req.args[0].clone(), req.args[1].clone(), OscType::Float(length)],
                        )
                        .await;
                }
                "/live/arrangement_clip/get/num_notes" => {
                    if !(arrangement_clip_exists(&track, int_at(1)) && clip_is_midi(&track)) {
                        continue;
                    }
                    let index = int_at(1).unwrap_or(0).to_string();
                    let count =
                        track["arrangementNotes"][&index].as_array().map(|n| n.len()).unwrap_or(0);
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
                _ => {} // including /live/mixingpal/get/device/identity: see the doc comment
            }
        }
    });

    Arc::new(LiveQuery::new(app, table))
}

pub struct Turn {
    pub answer: String,
    pub called: Vec<String>,
    /// Set when the loop exhausted `MAX_ROUND_TRIPS` without a final answer.
    /// Mirrors `runTurn`'s own `truncated` flag in `src/agent/loop.ts`: a
    /// scenario that ran out of steps answered nothing, and an assertion
    /// that checks only tool calls or wording would otherwise read that
    /// exhaustion as success -- including the empty string it returns
    /// satisfying a "does not contain X" check for free.
    pub truncated: bool,
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
}

/// One turn against the real provider, tools answered by the fake Live.
/// The context block rides ahead of the question as a user turn, exactly
/// as `Conversation.tsx` sends it.
pub async fn ask(f: Value, context: &str, question: &str) -> Turn {
    let ctx = ToolContext {
        coalescer: mirror(&f),
        query: Arc::new(Mutex::new(Some(fake_live(f).await))),
    };
    let s = settings();
    let client = reqwest::Client::new();

    let mut messages = vec![ChatMessage {
        role: "user".into(),
        content: Some(format!("{context}\n\n---\n\n{question}")),
        tool_calls: None,
        tool_call_id: None,
    }];
    let mut called: Vec<String> = Vec::new();

    for _ in 0..MAX_ROUND_TRIPS {
        let completion: Completion = complete(&client, &s, messages.clone())
            .await
            .expect("the provider answered");
        if completion.tool_calls.is_empty() {
            return Turn { answer: completion.text, called, truncated: false };
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
            messages.push(ChatMessage {
                role: "tool".into(),
                content: Some(serde_json::to_string(&result).unwrap()),
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
            });
        }
    }
    Turn { answer: String::new(), called, truncated: true }
}
