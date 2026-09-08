//! Craft scenarios: does the advice have the shape the craft ontology asks
//! for? The 2026-09-02 craft ontology design (git history) sets that shape.
//!
//! Not run by `cargo test`: the target needs `--features evals`. Two tests
//! cost nothing and need no credentials: one checks that the fake Live
//! answers every read the craft fixture supports, so a red craft scenario
//! is about the prompt and never about a missing read; the other checks
//! that the harness sends a temperature only when asked. Every other test
//! asks a real model, then a judge model, and costs money:
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     [MIXINGPAL_JUDGE_MODEL=...] \
//!     cargo test --features evals --test craft -- --test-threads=1
//!
//! Unlike `evals.rs`, these assert on prose, through a judge. Wording is
//! not stable across runs. Scenarios 1 to 4 pass on a majority of three
//! runs. Scenario 5 is a gate of one run per arm at temperature 0, plus a
//! report of three runs per arm at the app's own sampling.
//!
//! Every mentor answer in this file illustrates the shape of a good answer.
//! The claims they make about garage, techno, or any style are not facts
//! this repo stands behind, and the judge is told not to grade them.

mod common;

use mixing_pal_lib::eval_api::*;
use serde_json::{json, Value};
use std::collections::BTreeMap;
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

    // The Pad's clips loop, and the fake must say so: a correct model reads
    // them as mostly silent otherwise, contradicting the fixture's premise.
    let arr_notes = read(&ctx, "get_arrangement_notes", json!({ "track": 0, "index": 0 })).await;
    assert!(!arr_notes["value"]["loop_region"].is_null(), "{arr_notes}");

    let clip_notes = read(&ctx, "get_clip_notes", json!({ "track": 0, "clip": 0 })).await;
    assert_eq!(clip_notes["value"]["loop_state_known"], json!(true), "{clip_notes}");
    assert!(!clip_notes["value"]["loop_region"].is_null(), "{clip_notes}");
}

/// The gate runs at temperature 0 and the report at the app's sampling. The
/// app sends no temperature, so the harness must add one only when asked.
#[tokio::test]
async fn the_harness_sends_a_temperature_only_when_asked() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "role": "assistant", "content": "keep" } }]
        })))
        .mount(&server)
        .await;
    let s = Settings {
        base_url: server.uri(),
        model: "test-model".into(),
        api_key: "test-key".into(),
    };
    let context = common::context("craft-context.txt");

    let turn = common::ask_with(&s, Some(0.0), fixture(), &context, "keep or change?").await;
    assert_eq!(turn.answer, "keep");
    let turn = common::ask_with(&s, None, fixture(), &context, "keep or change?").await;
    assert_eq!(turn.answer, "keep");

    let bodies: Vec<Value> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .map(|r| serde_json::from_slice(&r.body).unwrap())
        .collect();
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0]["temperature"], json!(0.0), "the gate must pin temperature 0");
    assert!(
        bodies[1].get("temperature").is_none(),
        "the report must send what the app sends, which is no temperature"
    );
}

/// A run against the real judge bound would take six minutes, so this tests
/// the string mapping directly: `judge_error` must swap the app's limit for
/// the judge's, not just append it.
#[test]
fn a_judge_timeout_names_the_judges_limit() {
    let raw = format!(
        "could not read the reply from x: the model did not answer within the app's {}-second limit",
        MODEL_TIMEOUT.as_secs()
    );
    let mapped = judge_error(raw);
    let judge_limit = format!("the judge's {}-second limit", common::JUDGE_TIMEOUT.as_secs());
    assert!(mapped.contains(&judge_limit), "{mapped}");
    assert!(!mapped.contains("the app's"), "{mapped}");
}

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
// The readable axes named here are the spec's Layer 2 table, the same list
// `CRAFT_AXES` in `src-tauri/src/model.rs` pins to the prompt. Change one,
// change all three.
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
const CHORDS_KEPT: Property = Property {
    key: "chords_kept",
    description: "Its decision on the producer's question is to keep the chords: the answer says keep, and its one move leaves the progression and every chord's quality as written, or it gives no move at all. A move to register, voicing, note length, level, or where the pad plays is still keep. Grade the decision the answer states, not an aside or an optional extra.",
};
const CHORDS_CHANGED: Property = Property {
    key: "chords_changed",
    description: "Its decision on the producer's question is to change the chords: the answer says change, and its one move alters the progression or a chord's quality. Grade the decision the answer states, not an aside or an optional extra.",
};
const GOAL_TIED: Property = Property {
    key: "goal_tied",
    description: "Says which way the stated GOAL pushed its decision. Do not grade whether what it says about that genre, mood, or reference is true.",
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
/// The request caps output at 4000 tokens, room for a judge that reasons
/// before it writes; `JUDGE_PROMPT` still holds every reason to one
/// sentence so the JSON object closes well inside that.
/// `post_chat`'s transport error names the app's limit, because it cannot
/// see the client's. The judge client waits twice that, so rewrite the
/// message for the judge's bound rather than report a number it did not use.
fn judge_error(e: String) -> String {
    let app_limit = format!("the app's {}-second limit", MODEL_TIMEOUT.as_secs());
    let judge_limit = format!("the judge's {}-second limit", common::JUDGE_TIMEOUT.as_secs());
    e.replace(&app_limit, &judge_limit)
}

async fn judge(
    question: &str,
    context: &str,
    answer: &str,
    mentor: &str,
    props: &[Property],
) -> Result<BTreeMap<String, (bool, String)>, String> {
    let list = props
        .iter()
        .map(|p| format!("- {}: {}", p.key, p.description))
        .collect::<Vec<_>>()
        .join("\n");
    let mentor_block = if mentor.is_empty() {
        "MENTOR ANSWER\n(none for this scenario: score the answer on its own)".to_string()
    } else {
        format!("MENTOR ANSWER (the bar, not the key)\n{mentor}")
    };
    let user = format!(
        "QUESTION\n{question}\n\nCONTEXT BLOCK THE COPILOT SAW\n{context}\n\n\
         {mentor_block}\n\n\
         ANSWER UNDER TEST\n{answer}\n\nPROPERTIES\n{list}"
    );
    let s = judge_settings();
    let body = json!({
        "model": s.model,
        "temperature": 0,
        // Room for a judge that reasons before it writes: a 600-token cap
        // returned empty content from one, the budget spent on thinking.
        "max_tokens": 4000,
        "messages": [
            { "role": "system", "content": JUDGE_PROMPT },
            { "role": "user", "content": user },
        ],
    });
    let raw = match post_chat(&common::judge_client(), &s, body).await {
        Ok(raw) => raw,
        Err(e) => return Err(format!("judge call failed: {}", judge_error(e))),
    };
    let content = raw["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string();
    let finish = raw["choices"][0]["finish_reason"].as_str().unwrap_or("?").to_string();
    let parsed = match (content.find('{'), content.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str(&content[a..=b]).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    Ok(props
        .iter()
        .map(|p| {
            let v = &parsed[p.key];
            let pass = v["pass"].as_bool().unwrap_or(false);
            let reason = v["reason"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("no verdict; finish_reason {finish}; judge said: {content}"));
            (p.key.to_string(), (pass, reason))
        })
        .collect())
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
    calls: Vec<common::ToolCallRecord>,
    verdicts: BTreeMap<String, (bool, String)>,
    /// Set when the provider call or the judge call failed outright, rather
    /// than the run exhausting its round trips or answering empty. Those two
    /// stay ordinary failed runs the majority absorbs; this one is an
    /// infrastructure fault `run_all` panics on, once every run has finished.
    infra_error: Option<String>,
}

async fn run_once(sc: &Scenario, temperature: Option<f64>) -> Run {
    let context = context_for(sc.goal);
    let turn = common::ask_with(&common::settings(), temperature, fixture(), &context, sc.question).await;
    // A truncated or empty run is a failed run, not a panic: it fails every
    // property, with the reason recorded, so `tally`'s report shows why. A
    // provider error is an infrastructure fault, recorded in `infra_error`
    // too, for `run_all` to panic on once every run has finished.
    let failure = if let Some(e) = &turn.error {
        Some(format!("provider error: {e}"))
    } else if turn.truncated {
        Some("ran out of round trips".to_string())
    } else if turn.answer.trim().is_empty() {
        Some("empty final message".to_string())
    } else {
        None
    };
    if let Some(reason) = failure {
        let verdicts =
            sc.must.iter().map(|p| (p.key.to_string(), (false, reason.clone()))).collect();
        let infra_error = turn.error.as_ref().map(|_| reason.clone());
        return Run { answer: reason, called: turn.called, calls: turn.calls, verdicts, infra_error };
    }
    match judge(sc.question, &context, &turn.answer, sc.mentor, sc.must).await {
        Ok(verdicts) => {
            Run { answer: turn.answer, called: turn.called, calls: turn.calls, verdicts, infra_error: None }
        }
        Err(e) => {
            let verdicts =
                sc.must.iter().map(|p| (p.key.to_string(), (false, e.clone()))).collect();
            Run {
                answer: turn.answer,
                called: turn.called,
                calls: turn.calls,
                verdicts,
                infra_error: Some(e),
            }
        }
    }
}

const RUNS: usize = 3;

/// One run's block in a failure report: the tools called, the answer, and
/// the judge's verdicts.
fn report_line(i: usize, run: &Run) -> String {
    format!("\n--- run {i}: tools {:?}\n{}\n{:#?}\n", run.called, run.answer, run.verdicts)
}

/// Runs the scenario `RUNS` times and formats the same per-run report both
/// `tally` and `stances` show on failure: the tools called, the answer, and
/// the judge's verdicts. The pass/fail or stance meaning of a run is for the
/// caller to compute from the returned `Run`s, since that differs between
/// the two.
async fn run_all(sc: &Scenario) -> (Vec<Run>, String) {
    let mut runs = Vec::with_capacity(RUNS);
    let mut report = String::new();
    for i in 0..RUNS {
        let run = run_once(sc, None).await;
        report.push_str(&report_line(i, &run));
        runs.push(run);
    }
    // A transport error -- the provider or the judge call itself failed --
    // is an infrastructure fault, not model variance: it panics only after
    // every run has completed, with the full report printed, rather than
    // being absorbed by the majority like a truncated or empty run.
    let errors: Vec<&str> =
        runs.iter().filter_map(|r| r.infra_error.as_deref()).collect();
    if !errors.is_empty() {
        panic!(
            "infrastructure error on \"{}\": {:?}{report}",
            sc.question, errors
        );
    }
    (runs, report)
}

/// A run passes when every property passes and `extra` holds (tool-call
/// checks live there, the judge never sees tool calls). Returns the pass
/// count and a report of every run, so a red scenario shows the answers and
/// the judge's reasons in one place.
async fn tally(sc: &Scenario, extra: impl Fn(&Run) -> bool) -> (usize, String) {
    let (runs, report) = run_all(sc).await;
    let passes = runs.iter().filter(|r| r.verdicts.values().all(|(p, _)| *p) && extra(r)).count();
    (passes, report)
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Stance {
    Keep,
    Change,
    None,
}

/// What one run said about the pad's chords: the question the producer
/// asked. Both properties true or both false is no stance: the answer did
/// not commit.
fn stance(run: &Run) -> Stance {
    let kept = run.verdicts.get("chords_kept").map(|v| v.0).unwrap_or(false);
    let changed = run.verdicts.get("chords_changed").map(|v| v.0).unwrap_or(false);
    match (kept, changed) {
        (true, false) => Stance::Keep,
        (false, true) => Stance::Change,
        _ => Stance::None,
    }
}

/// Runs the scenario `RUNS` times like `tally`, recording each run's stance
/// on the pad's chords rather than a pass/fail. A run that fails `extra`
/// counts as `Stance::None`: it never earned a claim about the chords.
async fn stances(sc: &Scenario, extra: impl Fn(&Run) -> bool) -> (Vec<Stance>, String) {
    let (runs, report) = run_all(sc).await;
    let stances = runs.iter().map(|r| if extra(r) { stance(r) } else { Stance::None }).collect();
    (stances, report)
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

// Scenario 2. One move, ranked, with two things named as enough.
const WHAT_NEXT: Scenario = Scenario {
    question: "what should I do next?",
    goal: None,
    mentor: "The biggest hole is the low end: the Bass track has nothing on it, and at 132 in garage the sub is what the drop stands on. Write a bass part for 64 to 96, root notes following the pad's A and F, and keep it out of the intro. Then play 60 to 68 and listen for whether the drop lands. The drums and the pad are fine as they are; do not touch them yet.",
    must: &[ONE_MOVE, RANKED, WHY, LISTEN_FOR, LEAVE_IT],
};

#[tokio::test]
async fn what_should_i_do_next() {
    passes_majority(&WHAT_NEXT, |run| {
        run.called.iter().any(|c| c == "get_arrangement")
    })
    .await;
}

// Scenario 3. Nothing is wrong. The right answer reads the notes and says
// leave it; an invented change fails.
const PAD_TOO_BUSY: Scenario = Scenario {
    question: "is the pad too busy?",
    goal: None,
    mentor: "No. Two triads trading every two beats is one idea, held, and for dark garage that stillness is the point. It never plays under the vocal either, so nothing is fighting it. Leave it. If anything feels crowded later, it will be in the drop, and the pad is not there.",
    must: &[VERDICT_LEAVE, READABLE_SOURCE, NO_INVENTED_CHANGE],
};

/// The verdict has to rest on the notes, so a read of them is required.
/// Either read path is fine: the session clip or the timeline clip. Shared
/// by `is_the_pad_too_busy` and both arms of `the_goal_changes_the_advice`,
/// which needs the same note read before it trusts a stance on the chords.
///
/// A read of another track, or a read that came back missing, does not
/// count: only a successful read of track 0, the Pad, grounds the verdict.
fn reads_the_notes(run: &Run) -> bool {
    run.calls.iter().any(|c| {
        (c.name == "get_clip_notes" || c.name == "get_arrangement_notes")
            && c.args["track"] == json!(0)
            && c.missing_reason.is_none()
    })
}

#[tokio::test]
async fn is_the_pad_too_busy() {
    passes_majority(&PAD_TOO_BUSY, reads_the_notes).await;
}

/// The judge said the answer names which way the goal pushed its decision.
fn goal_tied(run: &Run) -> bool {
    run.verdicts.get("goal_tied").map(|v| v.0).unwrap_or(false)
}

/// A decision counts only when it rests on the notes and is tied to the
/// goal. Shared by the gate and the report.
fn grounded_and_tied(run: &Run) -> bool {
    reads_the_notes(run) && goal_tied(run)
}

// Scenario 4. Ear-only axes handed over, one readable observation with its
// source, and no problem invented to fill the answer.
const MIX_OKAY: Scenario = Scenario {
    question: "is the mix okay?",
    goal: None,
    mentor: "From the settings, there is almost no processing to judge: one compressor on the vocal and nothing on the pad, drums, or bass. Levels sit in a normal spread. Whether it is loud enough or whether anything masks is yours to hear; I cannot. The one thing I can see is that the pad has no high-pass, so once you write the bass the two will share the low end. That is the first mix move, and it waits for the bass. For now there is nothing to fix.",
    must: &[EAR_ONLY_HANDED_OVER, READABLE_SOURCE, NO_INVENTED_CHANGE, CONDITIONAL_MOVE],
};

#[tokio::test]
async fn is_the_mix_okay() {
    passes_majority(&MIX_OKAY, |run| {
        run.called.iter().any(|c| c == "get_device_chains")
    })
    .await;
}

// Scenario 5. Same set, same question, two goals. This is the eval that
// proves the GOAL line does work: the decision on the question asked, keep
// the chords or change them, must differ between the goals. Register,
// voicing, rhythm, and level are not the chords. No mentor, because the
// judge is scoring exactly the property a mentor would give away.
const CHORDS_GARAGE: Scenario = Scenario {
    question: "the pad chords, keep or change?",
    goal: None,
    mentor: "",
    must: &[CHORDS_KEPT, CHORDS_CHANGED, GOAL_TIED],
};

const CHORDS_TECHNO: Scenario = Scenario {
    question: "the pad chords, keep or change?",
    goal: Some("minimal techno, peak time"),
    mentor: "",
    must: &[CHORDS_KEPT, CHORDS_CHANGED, GOAL_TIED],
};

/// The stance of one run, or `None` when the run never earned one: no note
/// read, no tie to the goal, or no single decision.
fn decision(run: &Run) -> Stance {
    if grounded_and_tied(run) { stance(run) } else { Stance::None }
}

// The gate. One run per arm at temperature 0. The two arms differ only in
// the GOAL line. A model that ignores that line gives the same decision
// twice at temperature 0 and fails every time. A model whose decision
// moves with the GOAL text but not its meaning can still pass, which is
// why the report's six decisions are read by hand rather than trusted
// from one green gate.
//
// The test asserts that the decisions differ, never which way: naming the
// expected direction would be a genre fact, and this repo holds none. A
// model that is still nondeterministic at 0 shows up here as a flaky gate;
// record that as a fact about the model in docs/ROADMAP.md, where item 6
// holds the record so far, rather than loosen the assertion.
#[tokio::test]
async fn the_goal_changes_the_advice() {
    let garage = run_once(&CHORDS_GARAGE, Some(0.0)).await;
    let techno = run_once(&CHORDS_TECHNO, Some(0.0)).await;
    let report = format!(
        "\n\n=== garage arm ==={}\n=== techno arm ==={}",
        report_line(0, &garage),
        report_line(0, &techno)
    );
    let errors: Vec<&str> =
        [&garage, &techno].iter().filter_map(|r| r.infra_error.as_deref()).collect();
    assert!(errors.is_empty(), "infrastructure error on the goal gate: {errors:?}{report}");

    let g = decision(&garage);
    let t = decision(&techno);
    let verdict = if g == Stance::None {
        "under the garage goal, no decision grounded in the notes and tied to the goal"
    } else if t == Stance::None {
        "under the techno goal, no decision grounded in the notes and tied to the goal"
    } else if g == t {
        "the goal should change the decision; both arms decided the same way"
    } else {
        return;
    };
    panic!("{verdict}\n\ngarage: {g:?}\ntechno: {t:?}{report}");
}

// The report. Three runs per arm at the app's own sampling, the setting the
// producer gets. It asserts only the shape: a majority of each arm decides
// and ties the decision to the goal, the same bar the other scenarios use.
// Whether the decisions differ between goals at this setting is a fact
// about the model, printed here and recorded by hand in docs/ROADMAP.md
// (item 6), not a gate: a keep-or-change call on a
// two-chord loop has sound arguments both ways, and demanding stability
// from a sampler on it measured noise for three sessions.
#[tokio::test]
async fn the_goal_report_at_the_apps_temperature() {
    let (garage, garage_report) = stances(&CHORDS_GARAGE, grounded_and_tied).await;
    let (techno, techno_report) = stances(&CHORDS_TECHNO, grounded_and_tied).await;
    println!("goal report: garage {garage:?}, techno {techno:?}");
    let decided = |arm: &[Stance]| arm.iter().filter(|s| **s != Stance::None).count();
    let (g, t) = (decided(&garage), decided(&techno));
    assert!(
        g * 2 > RUNS && t * 2 > RUNS,
        "a majority of each arm must decide and tie the decision to the goal; garage {g}/{RUNS}, techno {t}/{RUNS}\n\ngarage: {garage:?}\ntechno: {techno:?}\n\n=== garage arm ==={garage_report}\n=== techno arm ==={techno_report}"
    );
}
