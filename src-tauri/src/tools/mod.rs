pub mod clip_notes;
pub mod fence;
pub mod track_detail;

use crate::deltas::Coalescer;
use crate::osc::query::{LiveQuery, QueryError};
use serde::Serialize;
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

/// What every tool result carries, so the model can tell "Live said zero"
/// from "Live said nothing" from "too large to send" -- and, for a mirror
/// read, how old the value is. Told the age rather than left to imply live
/// truth.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ToolResult {
    /// `null` when the call produced nothing at all.
    ///
    /// A value AND a `missing_reason` together is a real state, not a
    /// contradiction: a paged clip read that answered some windows and not
    /// others returns the notes it got with `missing_reason: "too_large"`.
    /// `fresh` is false in that case, and the model is expected to say the
    /// read was partial rather than present it as the whole clip.
    pub value: serde_json::Value,
    /// Epoch milliseconds at which this call ran.
    pub queried_at: u64,
    /// Epoch milliseconds at which the underlying value was last observed.
    /// Equal to `queried_at` for a live query; older for a mirror read.
    pub fresh_as_of: Option<u64>,
    pub fresh: bool,
    pub missing_reason: Option<String>,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl ToolResult {
    fn live(value: serde_json::Value, missing_reason: Option<String>) -> Self {
        let at = now_millis();
        Self {
            fresh: missing_reason.is_none(),
            value,
            queried_at: at,
            fresh_as_of: Some(at),
            missing_reason,
        }
    }

    fn missing(reason: &str) -> Self {
        Self {
            value: serde_json::Value::Null,
            queried_at: now_millis(),
            fresh_as_of: None,
            fresh: false,
            missing_reason: Some(reason.to_string()),
        }
    }
}

/// What `execute` needs to reach the two data sources.
#[derive(Clone)]
pub struct ToolContext {
    pub coalescer: Arc<Mutex<Coalescer>>,
    /// `None` until the OSC socket binds. Managed before the bind attempt so
    /// the command is always answerable: a tool that needs a live query then
    /// reports `not_connected` instead of the window failing with "state not
    /// managed".
    pub query: Arc<Mutex<Option<Arc<LiveQuery>>>>,
}

/// The complete set of tools the model may call.
///
/// Backend-owned. The webview passes a tool NAME and arguments, never a
/// definition, so it cannot widen this list -- see the spec's "Where the
/// split actually falls". The descriptions are part of the contract: they
/// are what tells the model that `get_track_detail` is a cached read and
/// `get_clip_notes` goes to Live.
pub fn tool_schema() -> serde_json::Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "get_track_detail",
                "description": "Mixer state for one track: name, fader position, fader in dB, pan, mute, solo. Read from a local mirror that is refreshed about every 2 seconds, so the result carries the age of the data. Does not include devices.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." }
                    },
                    "required": ["track"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "get_clip_notes",
                "description": "Every MIDI note in one session-view clip, as pitch, start, duration, velocity, mute. Queried from Live at call time. A dense clip is fetched in pieces; if a piece cannot be read the result says so.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "clip": { "type": "integer", "description": "Zero-based clip slot index within that track." }
                    },
                    "required": ["track", "clip"]
                }
            }
        }
    ])
}

/// Reads a required integer argument. Absent or wrongly typed is reported,
/// never defaulted: answering about track 0 when the model asked about a
/// track it could not name is worse than answering nothing.
fn int_arg(args: &serde_json::Value, name: &str) -> Option<i64> {
    args.get(name)?.as_i64()
}

/// One track's mirrored name, used as its identity across a paged query.
///
/// Live resolves `song.tracks[i]` when it HANDLES a message, not when the
/// client sent it -- so a paged note fetch that straddles a track delete or
/// reorder reads a DIFFERENT clip for its later windows and merges the notes
/// into one answer. Sampling the name at both ends catches that. See the
/// spec's "A generation counter" section for why this beats a counter here:
/// a reorder leaves the track count untouched.
fn track_identity(coalescer: &Mutex<Coalescer>, track: i64) -> Option<serde_json::Value> {
    let c = coalescer.lock().ok()?;
    c.lookup("/live/track/get/name", &[json!(track)])?
        .args
        .get(1)
        .cloned()
}

/// Whether the track under a paged query moved between two identity samples.
///
/// Abstains when the mirror never held the track to begin with: with nothing
/// to compare against, reporting a change would be a guess, and this is a
/// guard against inventing data rather than a licence to invent a warning.
fn topology_moved(before: &Option<serde_json::Value>, after: &Option<serde_json::Value>) -> bool {
    match (before, after) {
        (None, _) => false,
        // The track fell out of the mirror entirely: a delete that shrank
        // num_tracks past this index (see evict_tracks_at_or_beyond).
        (Some(_), None) => true,
        (Some(b), Some(a)) => b != a,
    }
}

pub async fn execute(ctx: &ToolContext, name: &str, args: &serde_json::Value) -> ToolResult {
    match name {
        "get_track_detail" => {
            let Some(track) = int_arg(args, "track").filter(|t| *t >= 0) else {
                return ToolResult::missing("bad_arguments");
            };
            // Short guard, no await inside: the mirror read is synchronous.
            let found = match ctx.coalescer.lock() {
                Ok(c) => track_detail::get_track_detail(&c, track as u32, Instant::now()),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some((detail, age)) = found else {
                return ToolResult::missing("not_in_mirror");
            };
            let at = now_millis();
            ToolResult {
                value: serde_json::to_value(&detail).unwrap_or(serde_json::Value::Null),
                queried_at: at,
                fresh_as_of: Some(at.saturating_sub(age.as_millis() as u64)),
                fresh: track_detail::is_fresh(age),
                missing_reason: None,
            }
        }
        "get_clip_notes" => {
            let (Some(track), Some(clip)) = (
                int_arg(args, "track").filter(|t| *t >= 0),
                int_arg(args, "clip").filter(|c| *c >= 0),
            ) else {
                return ToolResult::missing("bad_arguments");
            };
            // Clone the Arc out and DROP the guard before awaiting -- a
            // std::sync::Mutex guard is !Send and holding one across an
            // .await would not compile, which is exactly why this codebase
            // uses one.
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Bracket the fetch with an identity sample. A paged read can
            // span several seconds, and merging two clips' notes into one
            // answer is the failure this catches.
            let before = track_identity(&ctx.coalescer, track);
            let outcome = clip_notes::get_clip_notes(
                &query,
                track as i32,
                clip as i32,
                clip_notes::QUERY_TIMEOUT,
            )
            .await;
            if topology_moved(&before, &track_identity(&ctx.coalescer, track)) {
                return ToolResult::missing("topology_changed");
            }

            match outcome {
                Ok(notes) => ToolResult::live(
                    json!({ "notes": notes.notes, "count": notes.notes.len() }),
                    notes.missing_reason,
                ),
                Err(QueryError::NoReply) => ToolResult::missing("no_reply"),
                Err(QueryError::Busy) => ToolResult::missing("busy"),
                Err(QueryError::Transport(e)) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
        _ => ToolResult::missing("unknown_tool"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deltas::Delta;

    fn disconnected_ctx(c: Coalescer) -> ToolContext {
        ToolContext {
            coalescer: Arc::new(Mutex::new(c)),
            query: Arc::new(Mutex::new(None)),
        }
    }

    fn one_track_mirror() -> Coalescer {
        let mut c = Coalescer::new();
        c.observe_delta(Delta {
            addr: "/live/track/get/name".to_string(),
            args: vec![serde_json::json!(0), serde_json::json!("Bass")],
        });
        c
    }

    #[test]
    fn the_schema_lists_exactly_the_two_tools_the_first_cut_ships() {
        let schema = tool_schema();
        let names: Vec<&str> = schema
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["function"]["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["get_track_detail", "get_clip_notes"]);
        // Every entry must be a well-formed OpenAI function tool, or a
        // provider rejects the whole request with a 400 that reads like a
        // model problem.
        for t in schema.as_array().unwrap() {
            assert_eq!(t["type"], "function");
            assert!(t["function"]["description"].is_string());
            assert_eq!(t["function"]["parameters"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn a_mirror_read_reports_an_age_that_is_older_than_its_query_time() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 0 })).await;
        assert_eq!(result.missing_reason, None);
        assert!(result.fresh);
        assert_eq!(result.value["name"], "«Bass»");
        let fresh_as_of = result.fresh_as_of.expect("a mirror read must report an age");
        assert!(fresh_as_of <= result.queried_at);
    }

    #[tokio::test]
    async fn a_track_the_mirror_has_never_seen_reports_a_reason_and_no_value() {
        let ctx = disconnected_ctx(one_track_mirror());
        let result = execute(&ctx, "get_track_detail", &serde_json::json!({ "track": 9 })).await;
        assert_eq!(result.value, serde_json::Value::Null);
        assert_eq!(result.missing_reason.as_deref(), Some("not_in_mirror"));
        assert!(!result.fresh);
    }

    #[tokio::test]
    async fn a_live_query_before_the_socket_binds_says_so_rather_than_hanging() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(
            &ctx,
            "get_clip_notes",
            &serde_json::json!({ "track": 0, "clip": 0 }),
        )
        .await;
        assert_eq!(result.missing_reason.as_deref(), Some("not_connected"));
    }

    #[tokio::test]
    async fn an_unknown_tool_is_reported_not_silently_empty() {
        let ctx = disconnected_ctx(Coalescer::new());
        let result = execute(&ctx, "delete_everything", &serde_json::json!({})).await;
        assert_eq!(result.missing_reason.as_deref(), Some("unknown_tool"));
        assert_eq!(result.value, serde_json::Value::Null);
    }

    #[test]
    fn track_identity_reads_the_mirrored_name() {
        let coalescer = Mutex::new(one_track_mirror());
        assert_eq!(track_identity(&coalescer, 0), Some(serde_json::json!("Bass")));
        assert_eq!(track_identity(&coalescer, 4), None);
    }

    #[test]
    fn topology_moved_reports_a_rename_a_reorder_and_a_delete() {
        let bass = Some(serde_json::json!("Bass"));
        let kick = Some(serde_json::json!("Kick"));
        // A reorder shows up here exactly as a rename does: a different name
        // now sits at the index the query was keyed on. That is the case a
        // generation counter driven by num_tracks would miss entirely.
        assert!(topology_moved(&bass, &kick));
        // The track fell out of the mirror: deleted.
        assert!(topology_moved(&bass, &None));
        assert!(!topology_moved(&bass, &bass));
    }

    #[test]
    fn topology_moved_abstains_when_the_mirror_never_held_the_track() {
        // No baseline means no comparison. Reporting a change here would
        // invent a warning, which is the same class of error as inventing a
        // value.
        assert!(!topology_moved(&None, &Some(serde_json::json!("Bass"))));
        assert!(!topology_moved(&None, &None));
    }

    #[tokio::test]
    async fn a_missing_or_wrongly_typed_argument_is_reported_not_defaulted() {
        // Defaulting a missing track index to 0 would answer a question the
        // model did not ask, about a track it did not name.
        let ctx = disconnected_ctx(one_track_mirror());
        for args in [serde_json::json!({}), serde_json::json!({ "track": "bass" })] {
            let result = execute(&ctx, "get_track_detail", &args).await;
            assert_eq!(result.missing_reason.as_deref(), Some("bad_arguments"));
        }
    }
}
