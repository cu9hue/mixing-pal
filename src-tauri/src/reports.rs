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
                let mut units = 0;
                let end = s.char_indices().find_map(|(index, ch)| {
                    units += ch.len_utf16();
                    (units > 16000).then_some(index)
                }).unwrap_or(s.len());
                if end < s.len() { limitations.push("Long exchange text was shortened."); }
                s[..end].to_owned()
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

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use uuid::Uuid;
use crate::proxy::ProxyError;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReportInput {
    pub id: Uuid,
    pub account_id: String,
    pub origin: String,
    pub description: String,
    pub include_diagnostics: bool,
    pub exchange: Option<Exchange>,
}

pub fn build_payload(input: &ReportInput, owner: &str, trace: &Trace, wire_version: Option<u64>, connected: bool) -> Result<Value, ProxyError> {
    if input.account_id != owner { return Err(ProxyError::new("account_changed", "Your account changed. Open the report again.")); }
    let description = input.description.trim();
    if description.is_empty() || description.encode_utf16().count() > 4000 || !["answer", "error", "settings"].contains(&input.origin.as_str()) {
        return Err(ProxyError::new("invalid_report", "Describe the problem in 1–4,000 characters."));
    }
    let exchange = input.exchange.as_ref().filter(|_| input.origin != "settings");
    let mut payload = json!({"id": input.id, "origin": input.origin, "description": description,
        "app_version": env!("CARGO_PKG_VERSION"), "wire_version": wire_version, "diagnostics_consent": null});
    if let Some(entry) = exchange.filter(|e| e.account_id.as_deref() == Some(owner)) {
        if let Some(id) = entry.turn_id.as_deref().and_then(|s| Uuid::parse_str(s).ok()) { payload["turn_id"] = json!(id); }
    }
    if input.include_diagnostics {
        payload["diagnostics_consent"] = json!("support-2026-10-03");
        payload["diagnostics"] = incident_snapshot(trace, owner, exchange,
            Some(json!({"connected": connected, "wire_version": wire_version})));
    }
    Ok(payload)
}

const DAY: u64 = 86_400_000;
const MAX_QUEUE: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportStatus { Queued, Received, NeedsSignIn, Failed, Deleting, Deleted, Expired }

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReportReceipt {
    pub id: Uuid,
    pub origin: String,
    pub turn_id: Option<Uuid>,
    pub created_at: u64,
    pub status: ReportStatus,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct PendingReport {
    pub owner: String,
    pub receipt: ReportReceipt,
    pub payload: Option<Value>,
}

pub struct ReportStore {
    pub path: PathBuf,
    pub entries: Vec<PendingReport>,
    unreadable: bool,
}

impl ReportStore {
    pub fn load(path: PathBuf) -> Self {
        let loaded = std::fs::metadata(&path).ok().filter(|m| m.len() <= MAX_QUEUE as u64)
            .and_then(|_| std::fs::read(&path).ok()).and_then(|bytes| serde_json::from_slice::<Vec<PendingReport>>(&bytes).ok());
        let unreadable = path.exists() && loaded.is_none();
        Self { path, entries: loaded.unwrap_or_default(), unreadable }
    }

    fn save(&mut self, entries: Vec<PendingReport>) -> Result<(), ProxyError> {
        let bytes = serde_json::to_vec(&entries).map_err(|_| storage_error())?;
        if bytes.len() > MAX_QUEUE { return Err(ProxyError::new("report_queue_full", "The report queue is full. Wait for pending reports to send or cancel one.")); }
        crate::proxy::write_private(&self.path, &bytes).map_err(|_| storage_error())?;
        self.entries = entries;
        self.unreadable = false;
        Ok(())
    }

    pub fn prune(&mut self, now: u64) -> Result<(), ProxyError> {
        if self.unreadable { return Err(storage_error()); }
        let mut entries = self.entries.clone();
        entries.retain(|e| e.receipt.status == ReportStatus::Deleting || now.saturating_sub(e.receipt.created_at) < 30 * DAY);
        for e in &mut entries {
            if now.saturating_sub(e.receipt.created_at) >= 7 * DAY && e.receipt.status != ReportStatus::Received
                && e.receipt.status != ReportStatus::Deleted && e.receipt.status != ReportStatus::Deleting {
                e.payload = None;
                e.receipt.status = ReportStatus::Expired;
            }
        }
        self.save(entries)
    }

    pub fn enqueue(&mut self, owner: &str, payload: Value, now: u64) -> Result<ReportReceipt, ProxyError> {
        self.prune(now)?;
        let id: Uuid = serde_json::from_value(payload["id"].clone()).map_err(|_| ProxyError::new("invalid_report", "The report reference is invalid."))?;
        if let Some(existing) = self.entries.iter().find(|e| e.receipt.id == id) {
            if existing.owner != owner || existing.payload.as_ref().is_some_and(|p| {
                // A retried form can observe newer diagnostics. Keep its first snapshot.
                ["origin", "description", "turn_id", "diagnostics_consent"].iter().any(|key| p[*key] != payload[*key])
                    || p["diagnostics"]["exchange"] != payload["diagnostics"]["exchange"]
            }) {
                return Err(ProxyError::new("report_conflict", "This report reference has different content."));
            }
            return Ok(existing.receipt.clone());
        }
        if self.entries.iter().filter(|e| e.payload.is_some() || e.receipt.status == ReportStatus::Deleting).count() >= 20 {
            return Err(ProxyError::new("report_queue_full", "Twenty reports are waiting. Wait for them to send or cancel one."));
        }
        let receipt = ReportReceipt { id, origin: payload["origin"].as_str().unwrap_or("settings").into(),
            turn_id: payload.get("turn_id").cloned().and_then(|v| serde_json::from_value(v).ok()),
            created_at: now, status: ReportStatus::Queued };
        let mut entries = self.entries.clone();
        entries.push(PendingReport { owner: owner.into(), receipt: receipt.clone(), payload: Some(payload) });
        self.save(entries)?;
        Ok(receipt)
    }

    pub fn update(&mut self, owner: &str, id: Uuid, status: ReportStatus) -> Result<(), ProxyError> {
        let mut entries = self.entries.clone();
        if let Some(e) = entries.iter_mut().find(|e| e.owner == owner && e.receipt.id == id) {
            // A late upload receipt cannot undo cancellation.
            if e.receipt.status == ReportStatus::Deleting && status != ReportStatus::Deleted { return Ok(()); }
            e.receipt.status = status;
            if matches!(e.receipt.status, ReportStatus::Received | ReportStatus::Deleting | ReportStatus::Deleted | ReportStatus::Expired) {
                e.payload = None;
            }
        }
        self.save(entries)
    }

    pub fn signed_in(&mut self, owner: &str) -> Result<(), ProxyError> {
        if self.unreadable { return Err(storage_error()); }
        let mut entries = self.entries.clone();
        entries.retain(|e| e.owner == owner);
        for e in &mut entries {
            if e.receipt.status == ReportStatus::NeedsSignIn { e.receipt.status = ReportStatus::Queued; }
        }
        self.save(entries)
    }

    pub fn clear(&mut self) -> Result<(), ProxyError> { self.save(Vec::new()) }
}

fn storage_error() -> ProxyError {
    ProxyError::new("report_storage_failed", "Could not save the report queue on this laptop. Your report has not been confirmed. Sign out to clear an unreadable queue.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn report_payload_needs_explicit_consent_and_pins_the_asking_account() {
        let input = ReportInput { id: Uuid::new_v4(), account_id: "producer".into(), origin: "answer".into(),
            description: "  wrong answer  ".into(), include_diagnostics: false, exchange: Some(exchange(Some("producer"))) };
        let body = build_payload(&input, "producer", &Trace::new(), None, false).unwrap();
        assert!(body.get("diagnostics").is_none());
        assert_eq!(body["diagnostics_consent"], Value::Null);
        assert_eq!(body["description"], "wrong answer");
        assert!(!body.to_string().contains("private question"));
        assert!(build_payload(&input, "other", &Trace::new(), None, false).is_err());
        let mut included = input;
        included.include_diagnostics = true;
        let body = build_payload(&included, "producer", &Trace::new(), Some(13), false).unwrap();
        assert_eq!(body["diagnostics"]["exchange"]["question"], "private question");
        assert_eq!(body["diagnostics_consent"], "support-2026-10-03");
    }

    fn store() -> ReportStore {
        ReportStore::load(std::env::temp_dir().join(format!("report-store-{}", Uuid::new_v4())).join("reports.json"))
    }
    fn payload() -> Value { json!({"id": Uuid::new_v4(), "origin": "settings", "description": "private"}) }

    #[test]
    fn reports_queue_cap_never_evicts_pending_content() {
        let mut store = store();
        for _ in 0..20 { store.enqueue("producer", payload(), 100).unwrap(); }
        assert!(store.enqueue("producer", payload(), 100).is_err());
        assert_eq!(store.entries.len(), 20);
        let restored = ReportStore::load(store.path.clone());
        assert_eq!(restored.entries.len(), 20);
        std::fs::remove_dir_all(store.path.parent().unwrap()).unwrap();
    }

    #[test]
    fn reports_expiry_erases_content_without_claiming_delivery() {
        let mut store = store();
        store.enqueue("producer", payload(), 100).unwrap();
        store.prune(100 + 7 * DAY).unwrap();
        assert_eq!(store.entries[0].receipt.status, ReportStatus::Expired);
        assert!(store.entries[0].payload.is_none());
        assert!(!std::fs::read_to_string(&store.path).unwrap().contains("private"));
        store.prune(100 + 30 * DAY).unwrap();
        assert!(store.entries.is_empty());
        std::fs::remove_dir_all(store.path.parent().unwrap()).unwrap();
    }

    #[test]
    fn reports_failed_disk_write_does_not_acknowledge_or_mutate_queue() {
        let mut store = store();
        std::fs::create_dir_all(store.path.parent().unwrap()).unwrap();
        std::fs::write(&store.path, b"corrupt").unwrap();
        let mut restored = ReportStore::load(store.path.clone());
        assert!(restored.enqueue("producer", payload(), 100).is_err());
        std::fs::create_dir_all(store.path.with_extension("tmp")).unwrap();
        assert!(store.enqueue("producer", payload(), 100).is_err());
        assert!(store.entries.is_empty());
        std::fs::remove_dir_all(store.path.parent().unwrap()).unwrap();
    }

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
        entry.answer = Some("🎵".repeat(300_000));
        let result = incident_snapshot(&crate::trace::Trace::new(), "producer", Some(&entry), None);
        assert_eq!(result["exchange"]["question"], "private question");
        assert!(result["exchange"]["answer"].as_str().unwrap().encode_utf16().count() <= 16000);
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
