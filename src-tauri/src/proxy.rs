//! Account transport. Credentials stay in Rust; public builds never use a
//! producer's provider settings to bypass account access.

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use uuid::Uuid;

const ORIGIN: &str = "https://api.mixingpal.com";
const CONSENT_VERSION: &str = "quality-2026-09-17";
const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const MAX_EVENT: usize = 1024 * 1024;
const MAX_OUTBOX: usize = 20 * MAX_EVENT;
const OUTBOX_AGE: u64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize)]
pub struct ProxyError {
    pub code: String,
    pub message: String,
}

impl ProxyError {
    fn new(code: &str, message: &str) -> Self {
        Self { code: code.into(), message: message.into() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Session {
    token: String,
    member_id: String,
}

pub trait Credentials: Send + Sync {
    fn read(&self, account: &str) -> Result<Option<String>, String>;
    fn write(&self, account: &str, value: &str) -> Result<(), String>;
    fn clear(&self, account: &str) -> Result<(), String>;
}

pub struct Keychain;

#[cfg(target_os = "macos")]
impl Credentials for Keychain {
    fn read(&self, account: &str) -> Result<Option<String>, String> {
        match security_framework::passwords::get_generic_password("com.mixingpal.app", account) {
            Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| "The saved session could not be read.".into()),
            Err(e) if e.code() == -25300 => Ok(None),
            Err(_) => Err("Unlock your keychain to sign in to Mixing Pal.".into()),
        }
    }
    fn write(&self, account: &str, value: &str) -> Result<(), String> {
        security_framework::passwords::set_generic_password("com.mixingpal.app", account, value.as_bytes())
            .map_err(|_| "The session could not be saved in your keychain.".into())
    }
    fn clear(&self, account: &str) -> Result<(), String> {
        match security_framework::passwords::delete_generic_password("com.mixingpal.app", account) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()),
            Err(_) => Err("The saved session could not be removed from your keychain.".into()),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Credentials for Keychain {
    fn read(&self, _: &str) -> Result<Option<String>, String> { Ok(None) }
    fn write(&self, _: &str, _: &str) -> Result<(), String> { Err("Secure sign-in storage is available on macOS.".into()) }
    fn clear(&self, _: &str) -> Result<(), String> { Ok(()) }
}

#[derive(Clone)]
struct Turn {
    member_id: String,
    capture: bool,
    epoch: u64,
    blocked: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct PendingEvent {
    member_id: String,
    turn_id: Uuid,
    epoch: u64,
    queued_at: u64,
    payload: Value,
}

#[derive(Default, Serialize, Deserialize)]
struct Outbox {
    events: Vec<PendingEvent>,
    #[serde(default)]
    gaps: Vec<PendingEvent>,
    pending_withdrawal: bool,
    #[serde(default)]
    withdrawal_id: Option<Uuid>,
}

pub struct Proxy {
    client: Client,
    origin: String,
    credentials: Box<dyn Credentials>,
    credential_name: String,
    session: Mutex<Option<Session>>,
    turns: Mutex<HashMap<Uuid, Turn>>,
    outbox: tokio::sync::Mutex<Outbox>,
    outbox_path: PathBuf,
    account_change: tokio::sync::Mutex<()>,
    uploading: tokio::sync::Mutex<()>,
}

impl Proxy {
    pub fn new(dir: &Path) -> Self {
        let origin = if cfg!(debug_assertions) {
            std::env::var("MIXINGPAL_PROXY_URL").unwrap_or_else(|_| ORIGIN.into())
        } else { ORIGIN.into() };
        Self::with_store(dir, origin, Box::new(Keychain))
    }

    fn with_store(dir: &Path, origin: String, credentials: Box<dyn Credentials>) -> Self {
        let origin = origin.trim_end_matches('/').to_owned();
        // Preserve production's existing state; alternate origins never read it.
        let credential_name = if origin == ORIGIN { "pilot-session".into() } else { format!("pilot-session:{origin}") };
        let outbox_path = if origin == ORIGIN { dir.join("pilot-outbox.json") } else {
            let mut path = dir.join("pilot-origins");
            for part in origin.as_bytes().chunks(64) {
                path.push(part.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
            }
            path.join("outbox.json")
        };
        let outbox = std::fs::metadata(&outbox_path).ok()
            .filter(|m| m.len() <= (MAX_OUTBOX + MAX_EVENT) as u64)
            .and_then(|_| std::fs::read(&outbox_path).ok())
            .and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_else(|| Outbox {
                pending_withdrawal: outbox_path.exists(), ..Outbox::default()
            });
        Self {
            client: Client::builder().connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(180)).redirect(reqwest::redirect::Policy::none()).build()
                .expect("the proxy HTTP configuration is valid"),
            origin, credentials, credential_name,
            session: Mutex::new(None), turns: Mutex::new(HashMap::new()),
            outbox: tokio::sync::Mutex::new(outbox), outbox_path,
            account_change: tokio::sync::Mutex::new(()),
            uploading: tokio::sync::Mutex::new(()),
        }
    }

    fn session(&self) -> Result<Option<Session>, ProxyError> {
        let mut session = self.session.lock().map_err(|_| ProxyError::new("session_error", "The session is unavailable."))?;
        if session.is_none() {
            *session = self.credentials.read(&self.credential_name).map_err(|e| ProxyError::new("keychain_error", &e))?
                .map(|raw| serde_json::from_str(&raw)).transpose()
                .map_err(|_| ProxyError::new("session_error", "The saved session is unreadable. Sign out and sign in again."))?;
        }
        Ok(session.clone())
    }

    async fn request(&self, method: Method, path: &str, body: Option<Value>, session: Option<&Session>) -> Result<(Value, Option<String>), ProxyError> {
        let mut builder = self.client.request(method, format!("{}{path}", self.origin));
        if !path.ends_with("/completions") { builder = builder.timeout(Duration::from_secs(15)); }
        if let Some(s) = session { builder = builder.bearer_auth(&s.token); }
        if let Some(value) = body { builder = builder.json(&value); }
        let mut response = builder.send().await.map_err(|_| ProxyError::new("connection_failed", "Could not reach Mixing Pal. Check your connection and try again."))?;
        let status = response.status();
        let token = response.headers().get("set-auth-token").and_then(|h| h.to_str().ok()).map(str::to_owned);
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| ProxyError::new("connection_failed", "The reply was interrupted. It has not been retried."))? {
            if bytes.len() + chunk.len() > MAX_RESPONSE {
                return Err(ProxyError::new("response_too_large", "The service reply was too large."));
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| ProxyError::new("invalid_response", "The service returned an unreadable reply."))?;
        if !status.is_success() {
            let code = value["error"]["code"].as_str().unwrap_or("service_unavailable");
            let message = value["error"]["message"].as_str().unwrap_or("Mixing Pal is temporarily unavailable.");
            let message = session.map_or_else(|| message.into(), |s| message.replace(&s.token, "[redacted]"));
            return Err(ProxyError::new(code, &message));
        }
        Ok((value, token))
    }

    pub async fn account(&self) -> Result<Value, ProxyError> {
        if cfg!(feature = "direct-provider") { return Ok(json!({ "access": "development", "capture": false })); }
        let Some(session) = self.session()? else { return Ok(json!({ "access": "signed_out", "capture": false })); };
        if self.outbox.lock().await.pending_withdrawal {
            if let Err(error) = self.consent(false).await {
                if error.code == "sign_in_required" { return Ok(json!({ "access": "signed_out", "capture": false })); }
                return Err(error);
            }
        }
        match self.request(Method::GET, "/v1/account", None, Some(&session)).await {
            Ok((view, _)) => Ok(view),
            Err(e) if e.code == "sign_in_required" => Ok(json!({ "access": "signed_out", "capture": false })),
            Err(e) => Err(e),
        }
    }

    pub async fn send_code(&self, email: String) -> Result<(), ProxyError> {
        self.request(Method::POST, "/auth/email-otp/send-verification-otp", Some(json!({ "email": email })), None).await?;
        Ok(())
    }

    pub async fn sign_in(&self, email: String, otp: String) -> Result<Value, ProxyError> {
        let previous = self.session()?;
        if self.outbox.lock().await.pending_withdrawal && previous.is_some() {
            if let Err(error) = self.consent(false).await {
                if error.code != "sign_in_required" { return Err(error); }
            }
        }
        let _change = self.account_change.lock().await;
        let (value, token) = self.request(Method::POST, "/auth/sign-in/email-otp", Some(json!({ "email": email, "otp": otp })), None).await?;
        let session = Session {
            token: token.filter(|s| !s.is_empty() && s.len() < 4096)
                .ok_or_else(|| ProxyError::new("invalid_response", "The service did not return a session."))?,
            member_id: value["user"]["id"].as_str().filter(|s| !s.is_empty()).ok_or_else(|| ProxyError::new("invalid_response", "The service did not return an account."))?.into(),
        };
        if self.outbox.lock().await.pending_withdrawal && previous.as_ref().is_some_and(|s| s.member_id != session.member_id) {
            self.request(Method::POST, "/auth/sign-out", Some(json!({})), Some(&session)).await?;
            return Err(ProxyError::new("consent_pending", "Sign back into your previous account to finish turning off sharing."));
        }
        self.credentials.write(&self.credential_name, &serde_json::to_string(&session).unwrap()).map_err(|e| ProxyError::new("keychain_error", &e))?;
        *self.session.lock().unwrap() = Some(session.clone());
        self.turns.lock().unwrap().clear();
        let mut outbox = self.outbox.lock().await;
        outbox.events.retain(|e| e.member_id == session.member_id);
        outbox.gaps.retain(|e| e.member_id == session.member_id);
        self.save_outbox(&outbox)?;
        drop(outbox);
        drop(_change);
        self.account().await
    }

    pub async fn redeem(&self, code: String) -> Result<Value, ProxyError> {
        let session = self.required_session()?;
        Ok(self.request(Method::POST, "/v1/invites/redeem", Some(json!({ "code": code })), Some(&session)).await?.0)
    }

    pub async fn sign_out(&self) -> Result<(), ProxyError> {
        if self.outbox.lock().await.pending_withdrawal && self.session()?.is_some() {
            self.consent(false).await?;
        }
        let _change = self.account_change.lock().await;
        if let Some(session) = self.session()? {
            // Do not report a successful sign-out if the remote session is
            // still usable. The producer can retry after reconnecting.
            self.request(Method::POST, "/auth/sign-out", Some(json!({})), Some(&session)).await?;
        }
        self.clear_local().await
    }

    async fn clear_local(&self) -> Result<(), ProxyError> {
        self.credentials.clear(&self.credential_name).map_err(|e| ProxyError::new("keychain_error", &e))?;
        *self.session.lock().unwrap() = None;
        self.turns.lock().unwrap().clear();
        let mut outbox = self.outbox.lock().await;
        *outbox = Outbox::default();
        self.save_outbox(&outbox)
    }

    fn required_session(&self) -> Result<Session, ProxyError> {
        self.session()?.ok_or_else(|| ProxyError::new("sign_in_required", "Sign in to Mixing Pal to continue."))
    }

    pub async fn consent(&self, enabled: bool) -> Result<Value, ProxyError> {
        let session = self.required_session()?;
        let withdrawal_id = if !enabled {
            let id = Uuid::new_v4();
            let mut outbox = self.outbox.lock().await;
            outbox.events.clear();
            outbox.gaps.clear();
            outbox.pending_withdrawal = true;
            outbox.withdrawal_id = Some(id);
            self.save_outbox(&outbox)?;
            for turn in self.turns.lock().unwrap().values_mut() { turn.capture = false; turn.blocked = true; }
            Some(id)
        } else { None };
        let _change = self.account_change.lock().await;
        if enabled && self.outbox.lock().await.pending_withdrawal {
            return Err(ProxyError::new("consent_pending", "Finish turning off sharing before enabling it again."));
        }
        let (view, _) = self.request(Method::PUT, "/v1/consent", Some(json!({ "enabled": enabled, "version": CONSENT_VERSION })), Some(&session)).await?;
        let mut outbox = self.outbox.lock().await;
        // An earlier response must not acknowledge a later withdrawal.
        if withdrawal_id.is_some() && outbox.withdrawal_id == withdrawal_id {
            outbox.pending_withdrawal = false;
            outbox.withdrawal_id = None;
            self.save_outbox(&outbox)?;
        }
        Ok(view)
    }

    pub async fn complete(&self, body: Value, turn_id: Uuid, request_id: Uuid, round: u8, capture_epoch: Option<u64>) -> Result<Value, ProxyError> {
        let session = {
            let outbox = self.outbox.lock().await;
            if outbox.pending_withdrawal {
                return Err(ProxyError::new("consent_pending", "Finish turning off sharing in Settings before asking again."));
            }
            let session = self.required_session()?;
            let mut turns = self.turns.lock().unwrap();
            if turns.len() >= 100 && !turns.contains_key(&turn_id) { turns.clear(); }
            turns.entry(turn_id).or_insert(Turn { member_id: session.member_id.clone(), capture: false, epoch: 0, blocked: false });
            session
        };
        let wire: Value = serde_json::from_str(include_str!("../../shared/wire-version.json")).unwrap();
        let payload = json!({ "body": body, "turn_id": turn_id, "request_id": request_id, "round": round,
            "app_version": env!("CARGO_PKG_VERSION"), "wire_version": wire["version"], "capture_epoch": capture_epoch });
        let (value, _) = self.request(Method::POST, "/v1/completions", Some(payload), Some(&session)).await?;
        if self.session()?.as_ref().map(|s| &s.member_id) != Some(&session.member_id) {
            return Err(ProxyError::new("account_changed", "The account changed while this answer was running."));
        }
        let mut turns = self.turns.lock().unwrap();
        let turn = turns.get_mut(&turn_id).ok_or_else(|| ProxyError::new("account_changed", "The account changed while this answer was running."))?;
        turn.capture = !turn.blocked && value["capture"].as_bool().unwrap_or(false);
        turn.epoch = value["consent_epoch"].as_u64().unwrap_or(0);
        Ok(value)
    }

    pub async fn event(&self, turn_id: Uuid, payload: Value) -> Result<(), ProxyError> {
        if cfg!(feature = "direct-provider") { return Ok(()); }
        let session = self.required_session()?;
        let mut outbox = self.outbox.lock().await;
        if outbox.pending_withdrawal || self.session()?.as_ref().map(|s| &s.member_id) != Some(&session.member_id) { return Ok(()); }
        let turn = self.turns.lock().unwrap().get(&turn_id).cloned();
        let Some(turn) = turn.filter(|t| t.member_id == session.member_id) else { return Ok(()); };
        let kind = payload["kind"].as_str().unwrap_or("");
        if !["tool", "terminal", "incomplete"].contains(&kind) {
            return Err(ProxyError::new("invalid_event", "Unknown turn event."));
        }
        let now = crate::tools::now_millis();
        let payload = if !turn.capture || turn.blocked {
            if kind != "terminal" { return Ok(()); }
            json!({ "id": payload["id"], "kind": "terminal", "at": now, "data": {
                "status": payload["data"]["status"].as_str().unwrap_or("interrupted"),
                "incomplete": payload["data"]["incomplete"].as_bool().unwrap_or(false) } })
        } else if serde_json::to_vec(&payload).map_or(MAX_EVENT + 1, |b| b.len()) > MAX_EVENT {
            json!({ "id": Uuid::new_v4(), "kind": "incomplete", "at": now, "data": null })
        } else { payload };
        outbox.events.push(PendingEvent { member_id: session.member_id, turn_id, epoch: turn.epoch, queued_at: now, payload });
        trim_outbox(&mut outbox, now);
        self.save_outbox(&outbox)
    }

    pub async fn flush(&self) -> Result<(), ProxyError> {
        let _upload = self.uploading.lock().await;
        for _ in 0..20 {
            let _change = self.account_change.lock().await;
            let Some(session) = self.session()? else { return Ok(()); };
            let next = {
                let mut outbox = self.outbox.lock().await;
                if outbox.pending_withdrawal { return Ok(()); }
                outbox.events.retain(|e| e.member_id == session.member_id);
                outbox.gaps.retain(|e| e.member_id == session.member_id);
                trim_outbox(&mut outbox, crate::tools::now_millis());
                self.save_outbox(&outbox)?;
                outbox.gaps.first().or_else(|| outbox.events.first()).cloned()
            };
            let Some(next) = next else { break; };
            if let Err(error) = self.request(Method::POST, &format!("/v1/turns/{}/events", next.turn_id), Some(next.payload.clone()), Some(&session)).await {
                if !["turn_not_found", "capture_deleted", "event_conflict", "invalid_request"].contains(&error.code.as_str()) { return Err(error); }
            }
            let mut outbox = self.outbox.lock().await;
            outbox.events.retain(|e| e.payload["id"] != next.payload["id"]);
            outbox.gaps.retain(|e| e.payload["id"] != next.payload["id"]);
            self.save_outbox(&outbox)?;
        }
        Ok(())
    }

    pub async fn feedback(&self, turn_id: Uuid, payload: Value) -> Result<Value, ProxyError> {
        let session = self.required_session()?;
        Ok(self.request(Method::POST, &format!("/v1/turns/{turn_id}/feedback"), Some(payload), Some(&session)).await?.0)
    }

    pub async fn delete_turn(&self, turn_id: Uuid) -> Result<(), ProxyError> {
        let _change = self.account_change.lock().await;
        let session = self.required_session()?;
        {
            let mut outbox = self.outbox.lock().await;
            if let Some(t) = self.turns.lock().unwrap().get_mut(&turn_id) { t.capture = false; t.blocked = true; }
            outbox.events.retain(|e| e.turn_id != turn_id);
            outbox.gaps.retain(|e| e.turn_id != turn_id);
            self.save_outbox(&outbox)?;
        }
        self.request(Method::DELETE, &format!("/v1/turns/{turn_id}/capture"), None, Some(&session)).await?;
        Ok(())
    }

    pub async fn delete_account(&self) -> Result<(), ProxyError> {
        let _change = self.account_change.lock().await;
        let session = self.required_session()?;
        self.request(Method::DELETE, "/v1/account", None, Some(&session)).await?;
        self.clear_local().await
    }

    fn save_outbox(&self, outbox: &Outbox) -> Result<(), ProxyError> {
        write_private(&self.outbox_path, &serde_json::to_vec(outbox).unwrap())
            .map_err(|_| ProxyError::new("capture_storage_failed", "Could not save pending sharing events on this laptop."))
    }
}

fn trim_outbox(outbox: &mut Outbox, now: u64) {
    outbox.gaps.retain(|e| now.saturating_sub(e.queued_at) < OUTBOX_AGE);
    while !outbox.events.is_empty() && (outbox.events.len() > 512
        || now.saturating_sub(outbox.events[0].queued_at) >= OUTBOX_AGE
        || serde_json::to_vec(&*outbox).unwrap().len() > MAX_OUTBOX) {
        let mut dropped = outbox.events.remove(0);
        if !outbox.gaps.iter().any(|e| e.turn_id == dropped.turn_id && e.member_id == dropped.member_id) {
            dropped.payload = json!({ "id": Uuid::new_v4(), "kind": "incomplete", "at": now, "data": null });
            dropped.queued_at = now;
            outbox.gaps.push(dropped);
            if outbox.gaps.len() > 512 { outbox.gaps.remove(0); }
        }
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path.parent().unwrap();
    std::fs::create_dir_all(parent)?;
    let temporary = path.with_extension("tmp");
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)] {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))?;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    std::fs::rename(temporary, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    #[derive(Clone, Default)]
    struct Memory(Arc<Mutex<HashMap<String, String>>>);
    impl Credentials for Memory {
        fn read(&self, account: &str) -> Result<Option<String>, String> { Ok(self.0.lock().unwrap().get(account).cloned()) }
        fn write(&self, account: &str, value: &str) -> Result<(), String> { self.0.lock().unwrap().insert(account.into(), value.into()); Ok(()) }
        fn clear(&self, account: &str) -> Result<(), String> { self.0.lock().unwrap().remove(account); Ok(()) }
    }

    struct Fixture { dir: PathBuf, store: Memory, server: MockServer }
    impl Fixture {
        async fn new() -> Self {
            let fixture = Self { dir: std::env::temp_dir().join(format!("mixing-pal-proxy-test-{}", Uuid::new_v4())),
                store: Memory::default(), server: MockServer::start().await };
            fixture.store.write(&fixture.proxy().credential_name, &json!({ "token": "private-session", "member_id": "producer" }).to_string()).unwrap();
            fixture
        }
        fn proxy(&self) -> Proxy { Proxy::with_store(&self.dir, self.server.uri(), Box::new(self.store.clone())) }
        async fn route(&self, verb: &str, route: &str, status: u16, value: Value) {
            Mock::given(method(verb)).and(path(route)).respond_with(ResponseTemplate::new(status).set_body_json(value)).mount(&self.server).await;
        }
        async fn turn(&self, proxy: &Proxy, capture: bool) -> Uuid {
            self.route("POST", "/v1/completions", 200, json!({ "text": "answer", "tool_calls": [], "capture": capture, "consent_epoch": 1 })).await;
            let turn = Uuid::new_v4();
            proxy.complete(json!({ "messages": [] }), turn, Uuid::new_v4(), 1, capture.then_some(1)).await.unwrap();
            turn
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); } }

    fn event(kind: &str, data: Value) -> Value {
        json!({ "id": Uuid::new_v4(), "kind": kind, "at": crate::tools::now_millis(), "data": data })
    }

    #[tokio::test]
    async fn staging_sign_in_and_sign_out_preserve_the_production_credential() {
        let fixture = Fixture::new().await;
        let production = || Proxy::with_store(&fixture.dir, ORIGIN.into(), Box::new(fixture.store.clone()));
        let staging = fixture.proxy();
        fixture.store.clear(&staging.credential_name).unwrap();
        fixture.store.write(&production().credential_name, &json!({ "token": "private-session", "member_id": "producer" }).to_string()).unwrap();
        assert_eq!(production().credential_name, "pilot-session");
        assert!(staging.session().unwrap().is_none(), "staging must not read the production credential");
        Mock::given(method("POST")).and(path("/auth/sign-in/email-otp"))
            .respond_with(ResponseTemplate::new(200).insert_header("set-auth-token", "staging-session")
                .set_body_json(json!({ "user": { "id": "staging-member" } }))).mount(&fixture.server).await;
        fixture.route("GET", "/v1/account", 200, json!({ "access": "active", "capture": false })).await;
        fixture.route("POST", "/auth/sign-out", 200, json!({ "success": true })).await;
        staging.sign_in("invited@example.com".into(), "123456".into()).await.unwrap();
        assert_eq!(production().required_session().unwrap().token, "private-session");
        assert_eq!(fixture.proxy().required_session().unwrap().token, "staging-session");
        staging.sign_out().await.unwrap();
        assert!(fixture.proxy().session().unwrap().is_none());
        assert_eq!(production().required_session().unwrap().token, "private-session");
    }

    #[tokio::test]
    async fn staging_cannot_read_or_purge_the_production_outbox() {
        let fixture = Fixture::new().await;
        let production = || Proxy::with_store(&fixture.dir, ORIGIN.into(), Box::new(fixture.store.clone()));
        let outbox = Outbox { events: vec![PendingEvent { member_id: "producer".into(), turn_id: Uuid::new_v4(),
            epoch: 1, queued_at: crate::tools::now_millis(), payload: event("tool", json!({ "private": "production notes" })) }],
            pending_withdrawal: true, ..Outbox::default() };
        production().save_outbox(&outbox).unwrap();
        let staging = fixture.proxy();
        assert!(staging.outbox.lock().await.events.is_empty());
        assert!(!staging.outbox.lock().await.pending_withdrawal);
        staging.clear_local().await.unwrap();
        let restored = production();
        assert_eq!(restored.outbox.lock().await.events.len(), 1);
        assert!(restored.outbox.lock().await.pending_withdrawal);
        assert_eq!(restored.outbox_path, fixture.dir.join("pilot-outbox.json"));
        let same_origin = Proxy::with_store(&fixture.dir, format!("{}/", fixture.server.uri()), Box::new(fixture.store.clone()));
        assert_eq!(same_origin.outbox_path, staging.outbox_path);
    }

    #[tokio::test]
    async fn sign_in_persists_only_in_the_credential_store_and_sign_out_revokes_it() {
        let fixture = Fixture::new().await;
        fixture.store.clear(&fixture.proxy().credential_name).unwrap();
        Mock::given(method("POST")).and(path("/auth/sign-in/email-otp"))
            .respond_with(ResponseTemplate::new(200).insert_header("set-auth-token", "new-private-session")
                .set_body_json(json!({ "user": { "id": "producer" } }))).mount(&fixture.server).await;
        fixture.route("GET", "/v1/account", 200, json!({ "access": "active", "capture": false })).await;
        fixture.route("POST", "/auth/sign-out", 200, json!({ "success": true })).await;
        let proxy = fixture.proxy();
        let view = proxy.sign_in("invited@example.com".into(), "123456".into()).await.unwrap();
        assert!(!view.to_string().contains("private-session"));
        assert!(!std::fs::read_to_string(&proxy.outbox_path).unwrap().contains("private-session"));
        let restarted = fixture.proxy();
        assert_eq!(restarted.account().await.unwrap()["access"], "active");
        restarted.sign_out().await.unwrap();
        assert!(fixture.store.read(&restarted.credential_name).unwrap().is_none());
        let requests = fixture.server.received_requests().await.unwrap();
        assert_eq!(requests.last().unwrap().headers.get("authorization").unwrap(), "Bearer new-private-session");
    }

    #[tokio::test]
    async fn completion_sends_the_rust_built_prompt_with_ids_and_keeps_tools_local_without_capture() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        fixture.route("POST", "/v1/completions", 200, json!({ "text": "raw```note", "tool_calls": [], "capture": false })).await;
        let turn = Uuid::new_v4();
        let request = Uuid::new_v4();
        let body = crate::model::build_body(&crate::settings::Settings::default(), crate::settings::Experience::default(), &[]).unwrap();
        let out = proxy.complete(body.clone(), turn, request, 1, None).await.unwrap();
        assert_eq!(out["text"], "raw```note");
        proxy.event(turn, event("tool", json!({ "secret": "clip notes" }))).await.unwrap();
        assert!(proxy.outbox.lock().await.events.is_empty());
        let sent = fixture.server.received_requests().await.unwrap();
        assert_eq!(sent.len(), 1);
        let sent: Value = serde_json::from_slice(&sent[0].body).unwrap();
        assert_eq!(sent["body"], body);
        assert_eq!(sent["turn_id"], turn.to_string());
        assert_eq!(sent["request_id"], request.to_string());
        assert_eq!(sent["wire_version"], serde_json::from_str::<Value>(include_str!("../../shared/wire-version.json")).unwrap()["version"]);
    }

    #[tokio::test]
    async fn completion_forwards_the_turn_start_consent_without_refreshing_it() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        fixture.route("POST", "/v1/completions", 200, json!({ "text": "answer", "capture": false })).await;
        for epoch in [None, Some(3)] {
            proxy.complete(json!({}), Uuid::new_v4(), Uuid::new_v4(), 1, epoch).await.unwrap();
        }
        let requests = fixture.server.received_requests().await.unwrap();
        assert_eq!(requests.len(), 2);
        let bodies: Vec<Value> = requests.iter().map(|r| serde_json::from_slice(&r.body).unwrap()).collect();
        assert!(bodies[0]["capture_epoch"].is_null());
        assert_eq!(bodies[1]["capture_epoch"], 3);
    }

    #[tokio::test]
    async fn offline_withdrawal_purges_uploads_and_survives_restart() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        let turn = fixture.turn(&proxy, true).await;
        proxy.event(turn, event("tool", json!({ "private": "project data" }))).await.unwrap();
        fixture.route("PUT", "/v1/consent", 503, json!({ "error": { "code": "offline", "message": "offline" } })).await;
        assert_eq!(proxy.consent(false).await.unwrap_err().code, "offline");
        let file = std::fs::read_to_string(&proxy.outbox_path).unwrap();
        assert!(!file.contains("project data"));
        let restarted = fixture.proxy();
        assert_eq!(restarted.complete(json!({}), Uuid::new_v4(), Uuid::new_v4(), 1, None).await.unwrap_err().code, "consent_pending");
        fixture.server.reset().await;
        fixture.route("PUT", "/v1/consent", 200, json!({ "capture": false })).await;
        restarted.consent(false).await.unwrap();
        assert!(!restarted.outbox.lock().await.pending_withdrawal);
    }

    #[tokio::test]
    async fn an_earlier_consent_response_cannot_clear_a_newer_withdrawal() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        for enabled in [true, false] {
            let fixture = Fixture::new().await;
            let proxy = fixture.proxy();
            let started = Arc::new(tokio::sync::Notify::new());
            let calls = AtomicUsize::new(0);
            let signal = started.clone();
            Mock::given(method("PUT")).and(path("/v1/consent"))
                .respond_with(move |_: &wiremock::Request| {
                    if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        signal.notify_one();
                        ResponseTemplate::new(200).set_delay(Duration::from_millis(250))
                            .set_body_json(json!({ "capture": enabled }))
                    } else {
                        ResponseTemplate::new(503).set_body_json(json!({ "error": { "code": "offline" } }))
                    }
                }).mount(&fixture.server).await;
            let (earlier, later) = tokio::join!(proxy.consent(enabled), async {
                started.notified().await;
                proxy.consent(false).await
            });
            earlier.unwrap();
            assert_eq!(later.unwrap_err().code, "offline");
            assert_eq!(proxy.complete(json!({}), Uuid::new_v4(), Uuid::new_v4(), 1, None).await.unwrap_err().code, "consent_pending");
            assert_eq!(fixture.proxy().complete(json!({}), Uuid::new_v4(), Uuid::new_v4(), 1, None).await.unwrap_err().code, "consent_pending");
            assert_eq!(fixture.server.received_requests().await.unwrap().len(), 2);
        }
    }

    #[tokio::test]
    async fn an_expired_session_can_reauthenticate_without_losing_pending_withdrawal() {
        use wiremock::matchers::header;
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        fixture.route("PUT", "/v1/consent", 401, json!({ "error": { "code": "sign_in_required", "message": "expired" } })).await;
        assert!(proxy.consent(false).await.is_err());
        let restarted = fixture.proxy();
        assert_eq!(restarted.account().await.unwrap()["access"], "signed_out");
        Mock::given(method("POST")).and(path("/auth/sign-in/email-otp"))
            .respond_with(ResponseTemplate::new(200).insert_header("set-auth-token", "fresh-session")
                .set_body_json(json!({ "user": { "id": "producer" } }))).mount(&fixture.server).await;
        Mock::given(method("PUT")).and(path("/v1/consent")).and(header("authorization", "Bearer fresh-session"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({ "capture": false }))).with_priority(1).mount(&fixture.server).await;
        fixture.route("GET", "/v1/account", 200, json!({ "access": "active", "capture": false })).await;
        assert_eq!(restarted.sign_in("invited@example.com".into(), "123456".into()).await.unwrap()["capture"], false);
        assert!(!restarted.outbox.lock().await.pending_withdrawal);
    }

    #[tokio::test]
    async fn an_event_waiting_behind_deletion_cannot_repopulate_the_outbox() {
        let fixture = Fixture::new().await;
        let proxy = Arc::new(fixture.proxy());
        let turn = fixture.turn(&proxy, true).await;
        fixture.route("DELETE", &format!("/v1/turns/{turn}/capture"), 202, json!({ "deletion": "pending" })).await;
        let held = proxy.outbox.lock().await;
        let deleting = { let proxy = proxy.clone(); tokio::spawn(async move { proxy.delete_turn(turn).await }) };
        tokio::task::yield_now().await;
        let upload = { let proxy = proxy.clone(); tokio::spawn(async move { proxy.event(turn, event("tool", json!({ "private": "notes" }))).await }) };
        tokio::task::yield_now().await;
        drop(held);
        deleting.await.unwrap().unwrap();
        upload.await.unwrap().unwrap();
        assert!(proxy.outbox.lock().await.events.is_empty());
        assert!(!std::fs::read_to_string(&proxy.outbox_path).unwrap().contains("notes"));
    }

    #[tokio::test]
    async fn a_late_completion_cannot_restart_uploads_after_withdrawal() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        Mock::given(method("POST")).and(path("/v1/completions"))
            .respond_with(ResponseTemplate::new(200).set_delay(Duration::from_millis(100))
                .set_body_json(json!({ "text": "answer", "capture": true, "consent_epoch": 1 }))).mount(&fixture.server).await;
        fixture.route("PUT", "/v1/consent", 200, json!({ "capture": false })).await;
        let turn = Uuid::new_v4();
        let (completed, ()) = tokio::join!(proxy.complete(json!({}), turn, Uuid::new_v4(), 1, Some(1)), async {
            tokio::time::sleep(Duration::from_millis(20)).await;
            proxy.consent(false).await.unwrap();
        });
        completed.unwrap();
        proxy.event(turn, event("tool", json!({ "private": "notes" }))).await.unwrap();
        assert!(proxy.outbox.lock().await.events.is_empty());
    }

    #[tokio::test]
    async fn dropped_uploads_are_replaced_with_incomplete_markers_and_never_exceed_the_disk_cap() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        let turn = fixture.turn(&proxy, true).await;
        for _ in 0..24 { proxy.event(turn, event("tool", json!({ "result": "x".repeat(900_000) }))).await.unwrap(); }
        assert!(std::fs::metadata(&proxy.outbox_path).unwrap().len() <= MAX_OUTBOX as u64);
        let outbox = proxy.outbox.lock().await;
        assert_eq!(outbox.gaps.len(), 1);
        assert_eq!(outbox.gaps[0].payload["kind"], "incomplete");
        drop(outbox);
        proxy.event(turn, event("tool", json!({ "result": "y".repeat(MAX_EVENT) }))).await.unwrap();
        assert_eq!(proxy.outbox.lock().await.events.last().unwrap().payload["kind"], "incomplete");
    }

    #[tokio::test]
    async fn expired_outbox_content_is_not_uploaded_after_restart() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        let turn = fixture.turn(&proxy, true).await;
        proxy.event(turn, event("tool", json!({ "secret": "old clip" }))).await.unwrap();
        { let mut outbox = proxy.outbox.lock().await;
            outbox.events[0].queued_at -= OUTBOX_AGE + 1;
            proxy.save_outbox(&outbox).unwrap(); }
        fixture.route("POST", &format!("/v1/turns/{turn}/events"), 200, json!({ "saved": true })).await;
        let restarted = fixture.proxy();
        restarted.flush().await.unwrap();
        let requests = fixture.server.received_requests().await.unwrap();
        let body = String::from_utf8(requests.last().unwrap().body.clone()).unwrap();
        assert!(body.contains("incomplete"));
        assert!(!body.contains("old clip"));
        assert!(restarted.outbox.lock().await.events.is_empty());
    }

    #[tokio::test]
    async fn a_failed_first_completion_still_reports_its_terminal_state_and_redacts_credentials() {
        let fixture = Fixture::new().await;
        let proxy = fixture.proxy();
        let turn = Uuid::new_v4();
        fixture.route("POST", "/v1/completions", 502, json!({ "error": { "code": "provider_failed", "message": "error private-session" } })).await;
        let error = proxy.complete(json!({}), turn, Uuid::new_v4(), 1, None).await.unwrap_err();
        assert!(!error.message.contains("private-session"));
        fixture.route("POST", &format!("/v1/turns/{turn}/events"), 200, json!({ "saved": false })).await;
        proxy.event(turn, event("terminal", json!({ "status": "failed" }))).await.unwrap();
        assert_eq!(fixture.server.received_requests().await.unwrap().len(), 1);
        proxy.flush().await.unwrap();
        assert_eq!(fixture.server.received_requests().await.unwrap().len(), 2);
    }
}
