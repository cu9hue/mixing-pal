use serde::{Deserialize, Serialize};
use std::{path::PathBuf, time::Duration};
use tauri::Runtime;
use tauri_plugin_updater::{Update, Updater, UpdaterExt};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Pilot,
}
impl Channel {
    fn endpoint(self) -> &'static str {
        match self {
            Self::Stable => "https://api.mixingpal.com/v1/updates/stable",
            Self::Pilot => "https://api.mixingpal.com/v1/updates/pilot",
        }
    }
}
#[derive(Clone, Debug, Serialize)]
pub struct UpdateView {
    channel: Channel,
    phase: &'static str,
    version: Option<String>,
    notes: Option<String>,
    message: Option<String>,
}

pub struct UpdateState {
    channel: Channel,
    offer: Option<Update>,
    bytes: Option<Vec<u8>>,
}
impl UpdateState {
    fn new(channel: Channel) -> Self {
        Self {
            channel,
            offer: None,
            bytes: None,
        }
    }
    fn view(&self) -> UpdateView {
        UpdateView {
            channel: self.channel,
            phase: if self.bytes.is_some() {
                "ready"
            } else if self.offer.is_some() {
                "available"
            } else {
                "idle"
            },
            version: self.offer.as_ref().map(|u| u.version.clone()),
            notes: self.offer.as_ref().and_then(|u| u.body.clone()),
            message: None,
        }
    }
    async fn check(&mut self, updater: &Updater) -> Result<UpdateView, String> {
        let selected = check(updater).await?;
        let same = matches!((&self.offer, &selected), (Some(a), Some(b)) if same_offer(a, b));
        if !same {
            self.bytes = None;
        }
        self.offer = selected;
        Ok(self.view())
    }
    async fn download(&mut self) -> Result<UpdateView, String> {
        let offer = self.offer.as_ref().ok_or("Check for an update first.")?;
        self.bytes = None;
        let bytes =
            tokio::time::timeout(Duration::from_secs(300), offer.download(|_, _| {}, || {}))
                .await
                .map_err(|_| "The update download timed out. Try again.".to_string())?
                .map_err(|e| e.to_string())?;
        self.bytes = Some(bytes);
        Ok(self.view())
    }
    async fn verify_offer(&mut self, updater: &Updater) -> Result<(), String> {
        if self.bytes.is_none() {
            return Err("Download the update first.".into());
        }
        let selected = check(updater).await?;
        if !matches!((&self.offer, &selected), (Some(a), Some(b)) if same_offer(a, b)) {
            self.bytes = None;
            self.offer = selected;
            return Err("This update is no longer selected. Check for updates again.".into());
        }
        Ok(())
    }
    fn install(&mut self) -> Result<(), String> {
        let bytes = self.bytes.as_ref().ok_or("Download the update first.")?;
        self.offer
            .as_ref()
            .ok_or("Check for an update first.")?
            .install(bytes)
            .map_err(|e| e.to_string())
    }
}
fn same_offer(a: &Update, b: &Update) -> bool {
    a.version == b.version && a.download_url == b.download_url && a.signature == b.signature
}
async fn check(updater: &Updater) -> Result<Option<Update>, String> {
    tokio::time::timeout(Duration::from_secs(20), updater.check())
        .await
        .map_err(|_| "The update check timed out. Try again.".to_string())?
        .map_err(|e| e.to_string())
}

pub struct Updates {
    state: tokio::sync::Mutex<UpdateState>,
    path: PathBuf,
}
impl Updates {
    pub fn load(path: PathBuf) -> Self {
        let channel = crate::settings::load_update_channel(&path);
        Self {
            state: tokio::sync::Mutex::new(UpdateState::new(channel)),
            path,
        }
    }
}
fn configured_updater<R: Runtime>(
    app: &tauri::AppHandle<R>,
    channel: Channel,
) -> Result<Updater, String> {
    let config = app
        .config()
        .plugins
        .0
        .get("updater")
        .ok_or("App updates have no signing key configured.")?;
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(config.clone()).map_err(|e| e.to_string())?;
    if config.pubkey.trim().is_empty() {
        return Err("App updates have no signing key configured in this development build.".into());
    }
    if config.dangerous_insecure_transport_protocol
        || config.dangerous_accept_invalid_certs
        || config.dangerous_accept_invalid_hostnames
    {
        return Err("App updates require secure transport.".into());
    }
    app.updater_builder()
        .endpoints(vec![channel
            .endpoint()
            .parse()
            .map_err(|e| format!("Invalid update endpoint: {e}"))?])
        .map_err(|e| e.to_string())?
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub async fn check_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<UpdateView, String> {
    let mut state = updates
        .state
        .try_lock()
        .map_err(|_| "Another update operation is running.")?;
    let result = match configured_updater(&app, state.channel) {
        Ok(updater) => state.check(&updater).await,
        Err(error) => Err(error),
    };
    Ok(match result {
        Ok(view) => view,
        Err(error) => {
            let mut view = state.view();
            view.phase = "error";
            view.message = Some(error);
            view
        }
    })
}
#[tauri::command]
pub async fn download_update(updates: tauri::State<'_, Updates>) -> Result<UpdateView, String> {
    let mut state = updates
        .state
        .try_lock()
        .map_err(|_| "Another update operation is running.")?;
    state.download().await
}
#[tauri::command]
pub async fn install_update(
    app: tauri::AppHandle,
    updates: tauri::State<'_, Updates>,
) -> Result<(), String> {
    let mut state = updates
        .state
        .try_lock()
        .map_err(|_| "Another update operation is running.")?;
    let updater = configured_updater(&app, state.channel)?;
    state.verify_offer(&updater).await?;
    state.install()?;
    app.restart();
}
#[tauri::command]
pub async fn set_update_channel(
    channel: Channel,
    updates: tauri::State<'_, Updates>,
) -> Result<UpdateView, String> {
    let mut state = updates
        .state
        .try_lock()
        .map_err(|_| "Another update operation is running.")?;
    crate::settings::save_update_channel(&updates.path, channel).map_err(|e| e.to_string())?;
    *state = UpdateState::new(channel);
    Ok(state.view())
}

#[cfg(test)]
mod rehearsal;

#[cfg(test)]
mod tests {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    use std::io::Cursor;
    use tauri_plugin_updater::UpdaterExt;
    use wiremock::{matchers::path, Mock, MockServer, ResponseTemplate};

    pub(super) fn signed(bytes: &[u8]) -> (String, String) {
        let keys = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
        let signature =
            minisign::sign(Some(&keys.pk), &keys.sk, Cursor::new(bytes), None, None).unwrap();
        (
            STANDARD.encode(keys.pk.to_box().unwrap().to_string()),
            STANDARD.encode(signature.to_string()),
        )
    }
    pub(super) fn builder(key: &str) -> tauri::App<tauri::test::MockRuntime> {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.config_mut().plugins.0.insert(
            "updater".into(),
            serde_json::json!({"pubkey": key, "dangerousInsecureTransportProtocol": true}),
        );
        tauri::test::mock_builder()
            .plugin(tauri_plugin_updater::Builder::new().build())
            .build(context)
            .unwrap()
    }
    pub(super) fn updater(
        app: &tauri::App<tauri::test::MockRuntime>,
        server: &MockServer,
    ) -> Updater {
        app.updater_builder()
            .endpoints(vec![format!("{}/manifest", server.uri()).parse().unwrap()])
            .unwrap()
            .target("darwin-aarch64")
            .timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }
    pub(super) async fn offer(server: &MockServer, version: &str, signature: &str, artifact: &str) {
        Mock::given(path("/manifest")).respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "version":version, "notes":"Plain <b>text</b>", "platforms":{"darwin-aarch64":{"url":format!("{}{artifact}", server.uri()), "signature":signature}}
        }))).mount(server).await;
    }
    #[tokio::test]
    async fn downloads_only_verified_bytes_and_rechecks_the_selected_offer() {
        let bytes = b"temporary signed artifact";
        let (key, signature) = signed(bytes);
        let app = builder(&key);
        let server = MockServer::start().await;
        let updater = updater(&app, &server);
        offer(&server, "99.0.0", &signature, "/bundle").await;
        Mock::given(path("/bundle"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
            .mount(&server)
            .await;
        let mut state = UpdateState::new(Channel::Stable);
        assert_eq!(state.check(&updater).await.unwrap().phase, "available");
        assert_eq!(state.download().await.unwrap().phase, "ready");
        assert_eq!(state.bytes.as_deref(), Some(bytes.as_slice()));
        state.verify_offer(&updater).await.unwrap();
        server.reset().await;
        offer(&server, "99.0.1", &signature, "/bundle").await;
        assert!(state.verify_offer(&updater).await.is_err());
        assert!(state.bytes.is_none());
    }
    #[tokio::test]
    async fn pause_and_unavailable_checks_are_distinct_and_defer_installation() {
        let (key, _) = signed(b"artifact");
        let app = builder(&key);
        let server = MockServer::start().await;
        let updater = updater(&app, &server);
        let mut state = UpdateState::new(Channel::Stable);
        Mock::given(path("/manifest"))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        assert_eq!(state.check(&updater).await.unwrap().phase, "idle");
        server.reset().await;
        Mock::given(path("/manifest"))
            .respond_with(ResponseTemplate::new(503))
            .mount(&server)
            .await;
        assert!(state.check(&updater).await.is_err());
    }
    #[tokio::test]
    async fn url_and_signature_changes_and_pause_discard_downloads() {
        let bytes = b"artifact";
        let (key, signature) = signed(bytes);
        let app = builder(&key);
        let server = MockServer::start().await;
        let updater = updater(&app, &server);
        for change in ["url", "signature", "pause"] {
            server.reset().await;
            offer(&server, "99.0.0", &signature, "/bundle").await;
            Mock::given(path("/bundle"))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(bytes))
                .mount(&server)
                .await;
            let mut state = UpdateState::new(Channel::Stable);
            state.check(&updater).await.unwrap();
            state.download().await.unwrap();
            server.reset().await;
            if change == "pause" {
                Mock::given(path("/manifest"))
                    .respond_with(ResponseTemplate::new(204))
                    .mount(&server)
                    .await;
            } else {
                offer(
                    &server,
                    "99.0.0",
                    if change == "signature" {
                        "changed"
                    } else {
                        &signature
                    },
                    if change == "url" { "/new" } else { "/bundle" },
                )
                .await;
            }
            assert!(state.verify_offer(&updater).await.is_err());
            assert!(state.bytes.is_none());
            assert!(state.install().is_err());
        }
    }
    #[tokio::test]
    async fn plugin_refuses_a_downgrade_after_leaving_pilot() {
        let (key, signature) = signed(b"artifact");
        let app = builder(&key);
        let server = MockServer::start().await;
        offer(&server, "0.0.0", &signature, "/bundle").await;
        let mut state = UpdateState::new(Channel::Stable);
        assert_eq!(
            state.check(&updater(&app, &server)).await.unwrap().phase,
            "idle"
        );
    }
    #[test]
    fn channel_preferences_default_and_persist_separately_from_provider_settings() {
        let dir =
            std::env::temp_dir().join(format!("mixing-pal-update-prefs-{}", uuid::Uuid::new_v4()));
        assert_eq!(crate::settings::load_update_channel(&dir), Channel::Stable);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("updates.json"), "{}").unwrap();
        assert_eq!(crate::settings::load_update_channel(&dir), Channel::Stable);
        crate::settings::save_update_channel(&dir, Channel::Pilot).unwrap();
        crate::settings::save(&dir, &crate::settings::Settings::default()).unwrap();
        assert_eq!(crate::settings::load_update_channel(&dir), Channel::Pilot);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn invalid_signature_and_truncated_artifacts_never_become_ready() {
        let bytes = b"signed complete artifact";
        let (key, signature) = signed(bytes);
        let app = builder(&key);
        let server = MockServer::start().await;
        let updater = updater(&app, &server);
        for (sig, body) in [
            ("invalid signature", bytes.as_slice()),
            (signature.as_str(), &bytes[..5]),
        ] {
            server.reset().await;
            offer(&server, "99.0.0", sig, "/bundle").await;
            Mock::given(path("/bundle"))
                .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
                .mount(&server)
                .await;
            let mut state = UpdateState::new(Channel::Stable);
            state.check(&updater).await.unwrap();
            assert!(state.download().await.is_err());
            assert!(state.bytes.is_none());
        }
    }
}
