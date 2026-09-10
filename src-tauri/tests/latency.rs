//! Turn latency against a real provider and a fake Live.
//!
//! Not run by `cargo test`: the target needs `--features evals`, and the
//! measurement costs the operator money. The two harness tests below use a
//! mock provider and need no environment.
//!
//!   MIXINGPAL_EVAL_BASE_URL=... MIXINGPAL_EVAL_MODEL=... MIXINGPAL_EVAL_KEY=... \
//!     cargo test --features evals --test latency -- --nocapture

mod common;

use mixing_pal_lib::eval_api::Settings;
use serde_json::{json, Value};

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
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "choices": [{ "message": { "role": "assistant", "tool_calls": [{
                "id": "call_1", "type": "function",
                "function": { "name": "get_track_detail", "arguments": "{\"track\":0}" }
            }]}}]
        })))
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

    let turn = common::ask_with(&mock_settings(&server), None, fixture(), &context, "what is on track 0?").await;

    assert_eq!(turn.called, vec!["get_track_detail"]);
    assert_eq!(turn.round_trip_ms.len(), 2, "one reading per round trip: {:?}", turn.round_trip_ms);
    assert_eq!(turn.total_ms(), turn.round_trip_ms.iter().sum::<u64>());
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

    let turn = common::ask_with(&mock_settings(&server), None, fixture(), &context, "what is on track 0?").await;

    assert!(turn.error.is_some());
    assert_eq!(turn.round_trip_ms.len(), 1, "the failed round trip counts: {:?}", turn.round_trip_ms);
}
