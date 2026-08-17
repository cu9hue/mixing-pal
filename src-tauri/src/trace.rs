//! A capped, in-memory record of what the model was sent and what its tools
//! returned, so "why did the copilot say that?" is answerable by reading a
//! pane instead of diffing a filesystem.
//!
//! The motivating case: a copilot answer that says "I'm not getting
//! fader/pan values from the mirror" is either right (a decoder failed
//! closed on a bad reply) or wrong (the model is guessing). Without a trace,
//! telling those apart means reproducing the session. With one, the last
//! `get_track_detail` result shows `fader_db: null` and
//! `missing_reason` directly.

use serde::Serialize;
use std::collections::VecDeque;

/// Oldest steps are dropped once the buffer holds this many. This is an
/// always-on-top app a producer leaves running for a whole session; an
/// unbounded buffer holding several dense clip reads would balloon memory.
const MAX_STEPS: usize = 200;

/// Any stored value whose serialized form exceeds this many characters is
/// replaced by a truncation marker instead. A dense clip's notes are
/// thousands of values -- storing them in full defeats the point of a cap.
const MAX_VALUE_CHARS: usize = 4000;

/// How much of the oversized serialized form survives in the truncation
/// marker's `preview` field -- enough to recognise the shape of the value at
/// a glance.
const PREVIEW_CHARS: usize = 500;

/// One recorded step: either a call to the model or a call to a tool.
///
/// `outcome` (`Model`) is unambiguous about success vs failure by
/// construction -- see `TraceStep::model`'s caller in `lib.rs`, which wraps
/// it as `{"ok": ...}` or `{"error": ...}` before it ever reaches this type.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TraceStep {
    Model {
        /// Epoch millis, from the same `now_millis` every other timestamp in
        /// this app comes from (`tools::now_millis`) -- not a second clock.
        at: u64,
        request: serde_json::Value,
        outcome: serde_json::Value,
        duration_ms: u64,
    },
    Tool {
        at: u64,
        name: String,
        args: serde_json::Value,
        result: serde_json::Value,
        duration_ms: u64,
    },
}

impl TraceStep {
    /// Builds a `Model` step, truncating and redacting `request` and
    /// `outcome` before they are ever stored.
    ///
    /// `redact` is a value to scrub out of the stored JSON (the configured
    /// `base_url`, taken as a parameter rather than read from `Settings`
    /// here -- the API key travels as an HTTP header and is absent by
    /// construction, but a producer can paste a base URL carrying a key in
    /// its own query string).
    pub fn model(at: u64, request: serde_json::Value, outcome: serde_json::Value, duration_ms: u64, redact: &str) -> Self {
        TraceStep::Model {
            at,
            request: prepare_value(&request, redact),
            outcome: prepare_value(&outcome, redact),
            duration_ms,
        }
    }

    /// Builds a `Tool` step, truncating and redacting `args` and `result`
    /// before they are ever stored.
    pub fn tool(
        at: u64,
        name: String,
        args: serde_json::Value,
        result: serde_json::Value,
        duration_ms: u64,
        redact: &str,
    ) -> Self {
        TraceStep::Tool {
            at,
            name,
            args: prepare_value(&args, redact),
            result: prepare_value(&result, redact),
            duration_ms,
        }
    }
}

/// Redacts `needle` out of every string in `value`, then truncates the whole
/// thing if its serialized form is still too large. Redaction runs first so
/// a truncated preview never shows an unredacted fragment.
fn prepare_value(value: &serde_json::Value, needle: &str) -> serde_json::Value {
    let redacted = redact_value(value, needle);
    let serialized = serde_json::to_string(&redacted).unwrap_or_default();
    if serialized.chars().count() <= MAX_VALUE_CHARS {
        return redacted;
    }
    let preview: String = serialized.chars().take(PREVIEW_CHARS).collect();
    serde_json::json!({
        "truncated": true,
        "original_bytes": serialized.len(),
        "preview": preview,
    })
}

fn redact_value(value: &serde_json::Value, needle: &str) -> serde_json::Value {
    if needle.is_empty() {
        return value.clone();
    }
    match value {
        serde_json::Value::String(s) => serde_json::Value::String(s.replace(needle, "[redacted]")),
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(|v| redact_value(v, needle)).collect())
        }
        serde_json::Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                out.insert(k.clone(), redact_value(v, needle));
            }
            serde_json::Value::Object(out)
        }
        other => other.clone(),
    }
}

/// A capped ring buffer of `TraceStep`s. Cheap to clone the contents of
/// (`steps()`) rather than to hand out a reference, since the caller is
/// always a `#[tauri::command]` returning owned data across IPC anyway.
#[derive(Debug, Default)]
pub struct Trace {
    steps: VecDeque<TraceStep>,
}

impl Trace {
    pub fn new() -> Self {
        Self { steps: VecDeque::new() }
    }

    /// Appends one step, dropping the oldest if the buffer is already at
    /// `MAX_STEPS`.
    pub fn push(&mut self, step: TraceStep) {
        if self.steps.len() >= MAX_STEPS {
            self.steps.pop_front();
        }
        self.steps.push_back(step);
    }

    /// Every retained step, oldest first.
    pub fn steps(&self) -> Vec<TraceStep> {
        self.steps.iter().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.steps.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn small_tool_step(at: u64) -> TraceStep {
        TraceStep::tool(
            at,
            "get_track_detail".to_string(),
            serde_json::json!({ "track": 0 }),
            serde_json::json!({ "fader_db": null }),
            5,
            "",
        )
    }

    #[test]
    fn the_cap_drops_oldest_and_keeps_newest() {
        let mut trace = Trace::new();
        for i in 0..(MAX_STEPS as u64 + 10) {
            trace.push(small_tool_step(i));
        }
        let steps = trace.steps();
        assert_eq!(steps.len(), MAX_STEPS);
        match &steps[0] {
            TraceStep::Tool { at, .. } => assert_eq!(*at, 10, "the oldest 10 steps must be dropped"),
            other => panic!("expected Tool, got {other:?}"),
        }
        match steps.last().unwrap() {
            TraceStep::Tool { at, .. } => assert_eq!(*at, MAX_STEPS as u64 + 9, "the newest step must survive"),
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn a_small_value_is_stored_untouched() {
        let step = small_tool_step(1);
        match step {
            TraceStep::Tool { args, result, .. } => {
                assert_eq!(args, serde_json::json!({ "track": 0 }));
                assert_eq!(result, serde_json::json!({ "fader_db": null }));
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn a_value_over_the_threshold_is_replaced_with_a_truncation_marker() {
        let huge = serde_json::json!({ "notes": "x".repeat(MAX_VALUE_CHARS + 500) });
        let step = TraceStep::tool(1, "get_clip_notes".to_string(), serde_json::json!({}), huge, 5, "");
        match step {
            TraceStep::Tool { result, .. } => {
                assert_eq!(result["truncated"], true);
                assert!(result["original_bytes"].as_u64().unwrap() > MAX_VALUE_CHARS as u64);
                let preview = result["preview"].as_str().unwrap();
                assert!(preview.chars().count() <= PREVIEW_CHARS);
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn a_base_url_embedded_anywhere_in_a_nested_value_is_redacted() {
        let request = serde_json::json!({
            "messages": [
                { "role": "user", "content": "check https://example.test/v1?key=sk-abc please" }
            ],
            "nested": { "again": "prefix https://example.test/v1?key=sk-abc suffix" }
        });
        let step = TraceStep::model(1, request, serde_json::json!({ "ok": {} }), 5, "https://example.test/v1?key=sk-abc");
        match step {
            TraceStep::Model { request, .. } => {
                let serialized = serde_json::to_string(&request).unwrap();
                assert!(
                    !serialized.contains("sk-abc"),
                    "the base url must not survive redaction: {serialized}"
                );
                assert!(serialized.contains("[redacted]"));
            }
            other => panic!("expected Model, got {other:?}"),
        }
    }

    #[test]
    fn clear_empties_the_buffer() {
        let mut trace = Trace::new();
        trace.push(small_tool_step(1));
        trace.push(small_tool_step(2));
        trace.clear();
        assert!(trace.steps().is_empty());
    }
}
