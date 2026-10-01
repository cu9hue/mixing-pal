//! Turn latency against a real provider and a fake Live.
//!
//! Not run by `cargo test`: the target needs `--features evals`, and the
//! measurement costs the operator money. The two harness tests below use a
//! mock provider and need no environment.
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     cargo test --features evals --test latency a_two_tool -- --nocapture
//!
//! The run line's first number is the whole turn, tool execution against the
//! fake Live included; `provider` is the model's share of it, and a
//! `TRUNCATED` run means the model ran out of round trips, not that it was
//! slow.

mod common;

use std::time::Duration;

use mixing_pal_lib::eval_api::{Experience, Settings};
use serde_json::{json, Value};

use common::Turn;

fn fixture() -> Value {
    common::load("eval-set.json")
}

/// A provider that asks for one read, then answers. Mounted in that order:
/// an exhausted `up_to_n_times` mock stops matching, so the second mock
/// takes the second request.
async fn mount_one_read_then_answer(server: &wiremock::MockServer) {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(
            ResponseTemplate::new(200)
                .set_body_json(json!({
                    "choices": [{ "message": { "role": "assistant", "tool_calls": [{
                        "id": "call_1", "type": "function",
                        "function": { "name": "get_track_detail", "arguments": "{\"track\":0}" }
                    }]}}]
                }))
                .set_delay(Duration::from_millis(150)),
        )
        .up_to_n_times(1)
        .mount(server)
        .await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "role": "assistant", "content": "Track 0 is the kick." } }]
        })))
        .mount(server)
        .await;
}

fn mock_settings(server: &wiremock::MockServer) -> Settings {
    Settings {
        base_url: server.uri(),
        model: "test-model".into(),
        api_key: "test-key".into(),
    }
}

#[tokio::test]
async fn each_provider_round_trip_is_timed() {
    let server = wiremock::MockServer::start().await;
    mount_one_read_then_answer(&server).await;
    let context = common::context("eval-context.txt");

    let turn = common::ask_with(&mock_settings(&server), Experience::default(), None, fixture(), &context, "what is on track 0?").await;

    assert_eq!(turn.called, vec!["get_track_detail"]);
    assert_eq!(turn.round_trip_ms.len(), 2, "one reading per round trip: {:?}", turn.round_trip_ms);
    assert!(turn.round_trip_ms[0] >= 100, "{:?}", turn.round_trip_ms);
    assert!(turn.turn_ms >= turn.total_ms(), "{:?}", (turn.turn_ms, turn.total_ms()));
}

#[tokio::test]
async fn a_failed_round_trip_is_still_timed() {
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, ResponseTemplate};
    let server = wiremock::MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/chat/completions"))
        .respond_with(ResponseTemplate::new(500))
        .mount(&server)
        .await;
    let context = common::context("eval-context.txt");

    let turn = common::ask_with(&mock_settings(&server), Experience::default(), None, fixture(), &context, "what is on track 0?").await;

    assert!(turn.error.is_some());
    assert_eq!(turn.round_trip_ms.len(), 1, "the failed round trip counts: {:?}", turn.round_trip_ms);
}

/// The question and the check. "Is there any compression on the drums?"
/// reads the chain map, sees the Drum Rack marked [rack], and reads the
/// rack: two tools, three round trips. The rack read must come back whole,
/// so a fast answer that guessed or hit a bad-arguments reply does not
/// count, however fast it was.
const QUESTION: &str = "is there any compression on the drums?";
const REQUIRED_TOOL: &str = "get_rack_contents";
const RUNS: usize = 5;
/// Item 7's bar: a two-tool question in under a minute.
const BUDGET: Duration = Duration::from_secs(60);

fn seconds(ms: u64) -> f64 {
    ms as f64 / 1000.0
}

fn line(i: usize, t: &Turn) -> String {
    let mut s = format!(
        "run {i}: {:.1}s  provider {:.1}s  round trips {:?} ms  tools {:?}",
        seconds(t.turn_ms),
        seconds(t.total_ms()),
        t.round_trip_ms,
        t.called
    );
    if t.truncated {
        s.push_str("  TRUNCATED");
    }
    if let Some(e) = &t.error {
        s.push_str(&format!("  ERROR {e}"));
    }
    s
}

#[tokio::test]
async fn a_two_tool_question_answers_within_the_budget() {
    println!("model {}", common::settings().model);
    let context = common::context("craft-context.txt");
    let mut turns: Vec<Turn> = Vec::with_capacity(RUNS);
    let mut report = String::new();
    for i in 0..RUNS {
        let t = common::ask(common::load("craft-set.json"), &context, QUESTION).await;
        let l = line(i, &t);
        println!("{l}");
        report.push_str(&l);
        report.push('\n');
        turns.push(t);
    }

    // A provider error is an infrastructure fault, reported after every
    // run has finished so the report shows all five.
    let errors: Vec<&str> = turns.iter().filter_map(|t| t.error.as_deref()).collect();
    assert!(errors.is_empty(), "provider errors: {errors:?}\n{report}");

    let mut totals: Vec<u64> = turns.iter().map(|t| t.turn_ms).collect();
    totals.sort_unstable();
    let median = totals[RUNS / 2];

    for (i, t) in turns.iter().enumerate() {
        assert!(!t.truncated, "run {i} ran out of round trips\n{report}");
        assert!(!t.answer.trim().is_empty(), "run {i} answered nothing\n{report}");
        assert!(
            t.calls.iter().any(|c| c.name == REQUIRED_TOOL && c.missing_reason.is_none()),
            "run {i} did not read the rack in full\n{report}"
        );
    }
    println!("median {:.1}s  slowest {:.1}s", seconds(median), seconds(totals[RUNS - 1]));
    assert!(
        median < BUDGET.as_millis() as u64,
        "median {:.1}s is over the {}s budget\n{report}",
        seconds(median),
        BUDGET.as_secs()
    );
}
