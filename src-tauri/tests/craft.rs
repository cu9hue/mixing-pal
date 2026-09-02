//! Craft scenarios: does the advice have the shape the craft ontology asks
//! for? See docs/superpowers/specs/2026-09-02-craft-ontology-design.md.
//!
//! Not run by `cargo test`: the target needs `--features evals`. The first
//! test below costs nothing and needs no credentials: it checks that the
//! fake Live answers every read the craft fixture supports, so a red craft
//! scenario is about the prompt and never about a missing read. Every other
//! test asks a real model, then a judge model, and costs money:
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     [MIXINGPAL_JUDGE_MODEL=...] \
//!     cargo test --features evals --test craft -- --test-threads=1
//!
//! Unlike `evals.rs`, these assert on prose, through a judge. Wording is not
//! stable across runs, so each scenario passes on a majority of three.
#![allow(dead_code)] // property constants land ahead of the scenarios that use them

mod common;

use mixing_pal_lib::eval_api::*;
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

fn fixture() -> Value {
    common::load("craft-set.json")
}

async fn tools() -> ToolContext {
    let f = fixture();
    ToolContext {
        coalescer: common::mirror(&f),
        query: Arc::new(Mutex::new(Some(common::fake_live(f).await))),
    }
}

async fn read(ctx: &ToolContext, name: &str, args: Value) -> Value {
    serde_json::to_value(execute(ctx, name, &args).await).unwrap()
}

#[tokio::test]
async fn the_fake_live_serves_the_craft_fixture_in_full() {
    // The honesty fixture is deliberately broken. This one must not be: a
    // craft scenario that fails because a read came back missing is not a
    // finding about the prompt.
    let ctx = tools().await;
    let reads = [
        ("get_track_detail", json!({ "track": 0 })),
        ("get_clips", json!({})),
        ("get_clip_notes", json!({ "track": 0, "clip": 0 })),
        ("get_arrangement", json!({})),
        ("get_arrangement_notes", json!({ "track": 0, "index": 0 })),
        ("get_device_chains", json!({})),
        ("get_rack_contents", json!({ "track": 1, "path": [0] })),
        ("get_device_params", json!({ "track": 3, "path": [0] })),
    ];
    for (name, args) in reads {
        let r = read(&ctx, name, args.clone()).await;
        assert!(r["missing_reason"].is_null(), "{name} {args}: {r}");
        assert!(!r["value"].is_null(), "{name} {args}: {r}");
    }

    let detail = read(&ctx, "get_track_detail", json!({ "track": 0 })).await.to_string();
    assert!(detail.contains("-6.0 dB"), "the mirror should carry the fader: {detail}");

    let rack = read(&ctx, "get_rack_contents", json!({ "track": 1, "path": [0] })).await.to_string();
    for chain in ["Kick", "Clap", "Hats"] {
        assert!(rack.contains(chain), "{chain} missing from {rack}");
    }

    let comp = read(&ctx, "get_device_params", json!({ "track": 3, "path": [0] })).await.to_string();
    assert!(comp.contains("Threshold") && comp.contains("-18.0 dB"), "{comp}");
}

use std::collections::BTreeMap;

/// One thing the judge looks for. `description` is what the judge reads;
/// `key` is what it answers under.
struct Property {
    key: &'static str,
    description: &'static str,
}

const SECTION_PURPOSE: Property = Property {
    key: "section_purpose",
    description: "States, in about one sentence, what the section or element in question is for in the world the GOAL line names. Judge only that the statement is present and tied to the GOAL. Never judge whether it is true.",
};
const NAMED_AXIS: Property = Property {
    key: "named_axis",
    description: "Diagnoses on one named axis: energy contour, contrast at section boundaries, density and space, repetition against variation, low-end ownership, rhythmic relationship, or harmonic movement.",
};
const ONE_MOVE: Property = Property {
    key: "one_move",
    description: "Proposes exactly one concrete move. A list of alternatives fails.",
};
const WHY: Property = Property {
    key: "why",
    description: "Gives the reason for the move in terms of the axis it moves, not as a bare instruction.",
};
const LISTEN_FOR: Property = Property {
    key: "listen_for",
    description: "Ends with a test the producer performs by ear: where to play from and what to notice.",
};
const LEAVE_IT: Property = Property {
    key: "leave_it",
    description: "Names at least one thing that is fine and says to leave it alone.",
};
const RANKED: Property = Property {
    key: "ranked",
    description: "Says why this move comes first: what makes it the biggest gap.",
};
const VERDICT_LEAVE: Property = Property {
    key: "verdict_leave",
    description: "The verdict is to leave the pad as it is.",
};
const READABLE_SOURCE: Property = Property {
    key: "readable_source",
    description: "Every claim about the set names what it rests on: the notes, the arrangement, or device settings.",
};
const NO_INVENTED_CHANGE: Property = Property {
    key: "no_invented_change",
    description: "Does not propose changing anything it has not found a problem with.",
};
const EAR_ONLY_HANDED_OVER: Property = Property {
    key: "ear_only_handed_over",
    description: "Gives no verdict on tone, loudness, masking, groove, or feel. Where those come up, it hands the question to the producer.",
};
const CONDITIONAL_MOVE: Property = Property {
    key: "conditional_move",
    description: "Any move it gives is stated as waiting on something not yet done, or it gives no move at all.",
};
const MOVEMENT_DESIRABLE: Property = Property {
    key: "movement_desirable",
    description: "Treats the pad's harmonic movement, the chords changing, as something to keep or increase rather than to reduce or remove.",
};

const JUDGE_PROMPT: &str = "\
You grade one answer from a music-production copilot against a list of \
properties. The copilot cannot hear the set; it reads notes and settings. \
You are given the producer's question, the context block the copilot saw, \
a mentor answer that shows the bar, the answer under test, and the \
properties. The mentor answer is a reference for quality, not a key: an \
answer that reaches a different conclusion by a sound argument passes the \
same properties. Never grade whether a claim about a genre or a style is \
true. Reply with JSON only, no prose around it: an object with one entry \
per property key, each {\"pass\": true or false, \"reason\": \"one sentence\"}.";

struct Scenario {
    question: &'static str,
    /// `None` keeps the fixture's goal; `Some` replaces the GOAL line.
    goal: Option<&'static str>,
    mentor: &'static str,
    must: &'static [Property],
}

fn judge_settings() -> Settings {
    let s = common::settings();
    Settings {
        model: std::env::var("MIXINGPAL_JUDGE_MODEL").unwrap_or_else(|_| s.model.clone()),
        ..s
    }
}

/// `(pass, reason)` per property key. A judge reply that cannot be parsed
/// fails every property, with the raw text as the reason, so a broken
/// judge shows up as red runs with its output attached, never as green.
async fn judge(
    question: &str,
    context: &str,
    answer: &str,
    mentor: &str,
    props: &[Property],
) -> BTreeMap<String, (bool, String)> {
    let list = props
        .iter()
        .map(|p| format!("- {}: {}", p.key, p.description))
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "QUESTION\n{question}\n\nCONTEXT BLOCK THE COPILOT SAW\n{context}\n\n\
         MENTOR ANSWER (the bar, not the key)\n{mentor}\n\n\
         ANSWER UNDER TEST\n{answer}\n\nPROPERTIES\n{list}"
    );
    let s = judge_settings();
    let body = json!({
        "model": s.model,
        "temperature": 0,
        "messages": [
            { "role": "system", "content": JUDGE_PROMPT },
            { "role": "user", "content": user },
        ],
    });
    let raw = post_chat(&reqwest::Client::new(), &s, body).await.expect("the judge answered");
    let content = raw["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    let parsed = match (content.find('{'), content.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str(&content[a..=b]).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    props
        .iter()
        .map(|p| {
            let v = &parsed[p.key];
            let pass = v["pass"].as_bool().unwrap_or(false);
            let reason = v["reason"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("no verdict; judge said: {content}"));
            (p.key.to_string(), (pass, reason))
        })
        .collect()
}

fn context_for(goal: Option<&str>) -> String {
    let base = common::context("craft-context.txt");
    let Some(goal) = goal else { return base };
    let line = "GOAL  dark garage, 2am";
    assert!(base.contains(line), "the fixture's GOAL line moved; update `context_for`");
    base.replace(line, &format!("GOAL  {goal}"))
}

struct Run {
    answer: String,
    called: Vec<String>,
    verdicts: BTreeMap<String, (bool, String)>,
}

async fn run_once(sc: &Scenario) -> Run {
    let context = context_for(sc.goal);
    let turn = common::ask(fixture(), &context, sc.question).await;
    assert!(!turn.truncated, "ran out of round trips: {:?}", turn.called);
    assert!(!turn.answer.trim().is_empty(), "the provider returned an empty final message");
    let verdicts = judge(sc.question, &context, &turn.answer, sc.mentor, sc.must).await;
    Run { answer: turn.answer, called: turn.called, verdicts }
}

const RUNS: usize = 3;

/// Runs the scenario `RUNS` times. A run passes when every property passes
/// and `extra` holds (tool-call checks live there, the judge never sees
/// tool calls). Returns the pass count and a report of every run, so a red
/// scenario shows the answers and the judge's reasons in one place.
async fn tally(sc: &Scenario, extra: impl Fn(&Run) -> bool) -> (usize, String) {
    let mut passes = 0;
    let mut report = String::new();
    for i in 0..RUNS {
        let run = run_once(sc).await;
        let ok = run.verdicts.values().all(|(p, _)| *p) && extra(&run);
        passes += ok as usize;
        report.push_str(&format!(
            "\n--- run {i}: {} tools {:?}\n{}\n{:#?}\n",
            if ok { "PASS" } else { "FAIL" },
            run.called,
            run.answer,
            run.verdicts
        ));
    }
    (passes, report)
}

async fn passes_majority(sc: &Scenario, extra: impl Fn(&Run) -> bool) {
    let (passes, report) = tally(sc, extra).await;
    assert!(passes * 2 > RUNS, "{passes}/{RUNS} runs passed:{report}");
}

// Scenario 1. The gap the fixture was built around: the drop is the only
// place the pad leaves, and the bass that should arrive has not been
// written. The mentor's claim about what a garage drop is for is an
// illustration of the section-purpose rule, not a fact this repo holds.
const DROP_FALLS_FLAT: Scenario = Scenario {
    question: "why does the drop fall flat?",
    goal: None,
    mentor: "The drop is the first place the pad leaves, and nothing arrives in its place: the Bass track is empty. So the drop is the thinnest bar of the track, when in garage it should be the fullest. One move: write a bass for 64 to 96 that owns the sub, on the roots of your pad chords, A and F, and keep it out of the intro so the arrival is the contrast. Play from 60 and listen for whether bar 64 feels like a landing or a gap. Leave the drums alone; running through is the right thing for them to do.",
    must: &[SECTION_PURPOSE, NAMED_AXIS, ONE_MOVE, WHY, LISTEN_FOR, LEAVE_IT],
};

#[tokio::test]
async fn why_does_the_drop_fall_flat() {
    passes_majority(&DROP_FALLS_FLAT, |run| {
        run.called.iter().any(|c| c == "get_arrangement")
    })
    .await;
}
