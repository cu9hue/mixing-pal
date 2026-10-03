use crate::{threads::Exchange, trace::Trace};
use serde_json::{json, Value};

pub const MAX_DIAGNOSTICS: usize = 256 * 1024;

pub fn incident_snapshot(trace: &Trace, account: &str, exchange: Option<&Exchange>, connection: Option<Value>) -> Value {
    let mut result = json!({"format": "mixing-pal-incident-v1", "steps": [], "limitations": []});
    let mut limitations = Vec::new();
    if let Some(entry) = exchange {
        if entry.account_id.as_deref() != Some(account) {
            limitations.push("This conversation's account could not be verified. No conversation data attached.");
        } else {
            let mut text = |s: &str| {
                if s.chars().count() > 16000 { limitations.push("Long exchange text was shortened."); }
                s.chars().take(16000).collect::<String>()
            };
            result["exchange"] = json!({"question": text(&entry.question),
                "answer": entry.answer.as_deref().map(&mut text), "error": entry.error.as_deref().map(&mut text)});
            let steps = entry.turn_id.as_deref().map(|id| trace.incident_steps(account, id)).unwrap_or_default();
            if steps.is_empty() { limitations.push("The local trace is unavailable, possibly after restart or eviction."); }
            else { limitations.push("Local trace values are bounded previews; this is not a complete replay."); }
            result["steps"] = json!(steps);
        }
    } else if let Some(connection) = connection {
        result["connection"] = connection;
    }
    result["limitations"] = json!(limitations);
    if serde_json::to_vec(&result).unwrap().len() > MAX_DIAGNOSTICS {
        result["limitations"].as_array_mut().unwrap().push(json!("Earlier trace steps were omitted to fit the attachment limit."));
        while serde_json::to_vec(&result).unwrap().len() > MAX_DIAGNOSTICS {
            if result["steps"].as_array_mut().unwrap().is_empty() { break; }
            result["steps"].as_array_mut().unwrap().remove(0);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn exchange(owner: Option<&str>) -> crate::threads::Exchange {
        serde_json::from_value(json!({ "question": "private question", "answer": "answer", "error": null,
            "turnId": "turn", "accountId": owner })).unwrap()
    }

    #[test]
    fn snapshot_never_attaches_another_accounts_or_legacy_exchange() {
        for owner in [None, Some("other")] {
            let result = incident_snapshot(&crate::trace::Trace::new(), "producer", Some(&exchange(owner)), None);
            assert!(result.get("exchange").is_none());
            assert!(result["steps"].as_array().unwrap().is_empty());
            assert!(!result["limitations"].as_array().unwrap().is_empty());
        }
    }

    #[test]
    fn snapshot_marks_missing_trace_and_bounds_large_unicode_exchange() {
        let mut entry = exchange(Some("producer"));
        entry.answer = Some("音".repeat(300_000));
        let result = incident_snapshot(&crate::trace::Trace::new(), "producer", Some(&entry), None);
        assert_eq!(result["exchange"]["question"], "private question");
        assert!(serde_json::to_vec(&result).unwrap().len() <= 262144);
        assert!(result["limitations"].as_array().unwrap().len() >= 2);
    }

    #[test]
    fn settings_snapshot_contains_only_connection_status() {
        let result = incident_snapshot(&crate::trace::Trace::new(), "producer", None, Some(json!({"connected": false, "wire_version": null})));
        assert!(result.get("exchange").is_none());
        assert_eq!(result["connection"]["connected"], false);
        assert_eq!(result["steps"], json!([]));
    }
}
