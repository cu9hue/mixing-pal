use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// OpenRouter. Chosen because it standardises the tool-calling interface
/// across providers and exposes a filter for models that support it, so one
/// OpenAI-compatible adapter reaches a wide model set. The same adapter
/// reaches LM Studio, Ollama, and OpenAI by changing this value alone --
/// which is why it is a setting, not a constant in the client.
pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// The model the app calls when the producer has not named one. Chosen on
/// 2026-09-11 by `tests/latency.rs`: median 4.4 s over five runs of a
/// two-tool question, the fastest of seven candidates. The Settings pane
/// pre-fills it and shows it as the placeholder when the field is blank; a
/// blank field, on save or on load, means this.
pub const DEFAULT_MODEL: &str = "minimax/minimax-m3";

pub const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub base_url: String,
    pub model: String,
    /// Never leaves this process. No command returns it, and `SettingsView`
    /// has no field for it.
    pub api_key: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
            api_key: String::new(),
        }
    }
}

/// What the webview is allowed to see. Separate type rather than a
/// `skip_serializing` attribute on `Settings`, so the key cannot cross the
/// IPC boundary by anyone forgetting an attribute.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SettingsView {
    pub base_url: String,
    pub model: String,
    pub has_key: bool,
}

impl From<&Settings> for SettingsView {
    fn from(s: &Settings) -> Self {
        Self {
            base_url: s.base_url.clone(),
            model: s.model.clone(),
            has_key: !s.api_key.is_empty(),
        }
    }
}

/// Reads the settings file, falling back to defaults for a first run or a
/// file that no longer parses. Refusing to start over a corrupt settings
/// file would strand the producer with no way to fix it from inside the app.
/// A file whose model is blank loads the default, the same rule Save applies.
pub fn load(dir: &Path) -> Settings {
    let mut s: Settings = std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if s.model.trim().is_empty() {
        s.model = DEFAULT_MODEL.to_string();
    }
    s
}

pub fn save(dir: &Path, s: &Settings) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let path: PathBuf = dir.join(SETTINGS_FILE);
    let body = serde_json::to_string_pretty(s)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&path, body)?;
    // The file holds an API key. Not a substitute for a keychain, which is
    // the right home for it and is deliberately out of scope here -- but a
    // world-readable key in a shared home directory is a gap worth closing
    // for the cost of two lines.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // create_dir_all leaves the directory at the platform default (a
        // typical XDG config dir is 755), which would make the directory
        // holding the key file world-traversable even though the file
        // itself is 0600.
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A unique scratch directory per test, without pulling in a temp-file
    /// crate for four tests.
    fn scratch() -> PathBuf {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "mixing-pal-settings-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn settings_round_trip_through_disk() {
        let dir = scratch();
        let written = Settings {
            base_url: "https://openrouter.ai/api/v1".to_string(),
            model: "moonshotai/kimi-k2".to_string(),
            api_key: "sk-secret".to_string(),
        };
        save(&dir, &written).unwrap();
        assert_eq!(load(&dir), written);
    }

    #[test]
    fn a_missing_file_loads_defaults_rather_than_failing() {
        // First run. The producer has not been to the settings pane yet.
        let loaded = load(&scratch());
        assert_eq!(loaded.base_url, DEFAULT_BASE_URL);
        assert_eq!(loaded.model, DEFAULT_MODEL);
        assert!(loaded.api_key.is_empty());
    }

    #[test]
    fn a_blank_model_in_the_file_loads_the_default() {
        // A file written before the default existed, or hand-edited: the
        // key is kept and the model takes the default.
        let dir = scratch();
        std::fs::write(
            dir.join(SETTINGS_FILE),
            r#"{"base_url":"https://openrouter.ai/api/v1","model":"  ","api_key":"sk-kept"}"#,
        )
        .unwrap();
        let loaded = load(&dir);
        assert_eq!(loaded.model, DEFAULT_MODEL);
        assert_eq!(loaded.api_key, "sk-kept");
    }

    #[test]
    fn a_corrupt_file_loads_defaults_rather_than_panicking() {
        let dir = scratch();
        std::fs::write(dir.join(SETTINGS_FILE), "{ not json").unwrap();
        assert_eq!(load(&dir).base_url, DEFAULT_BASE_URL);
    }

    #[test]
    fn the_view_handed_to_the_webview_never_carries_the_key() {
        // The spec: "The API key lives in Rust and never enters the web
        // context." SettingsView has no field for it, so this is enforced by
        // the type -- the test pins that the type is what gets sent.
        let view = SettingsView::from(&Settings {
            base_url: "https://example.test/v1".to_string(),
            model: "m".to_string(),
            api_key: "sk-secret".to_string(),
        });
        assert!(view.has_key);
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("sk-secret"), "serialised view leaked the key: {json}");
    }

    #[test]
    fn experience_round_trips_and_is_none_until_chosen() {
        let dir = scratch();
        assert_eq!(load_experience(&dir), None);
        save_experience(&dir, Experience::NewToLive).unwrap();
        assert_eq!(load_experience(&dir), Some(Experience::NewToLive));
        let raw = std::fs::read_to_string(dir.join(PREFERENCES_FILE)).unwrap();
        assert_eq!(raw, r#"{"experience":"new_to_live"}"#, "the webview's union depends on these names");
    }

    #[test]
    fn saving_settings_leaves_the_experience_alone() {
        let dir = scratch();
        save_experience(&dir, Experience::MixesForOthers).unwrap();
        save(&dir, &Settings::default()).unwrap();
        assert_eq!(load_experience(&dir), Some(Experience::MixesForOthers));
    }

    #[cfg(unix)]
    #[test]
    fn the_settings_file_is_not_readable_by_other_users() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch();
        save(&dir, &Settings::default()).unwrap();
        let mode = std::fs::metadata(dir.join(SETTINGS_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600, "the file holds an API key");
        let dir_mode = std::fs::metadata(&dir).unwrap().permissions().mode();
        assert_eq!(
            dir_mode & 0o777,
            0o700,
            "the directory holding the key file must not be world-traversable"
        );
    }
}

/// Update preferences have their own file so account/provider saves cannot overwrite them.
pub fn load_update_channel(dir: &Path) -> crate::updates::Channel {
    #[derive(Default, Deserialize)]
    struct Preferences { #[serde(default)] channel: crate::updates::Channel }
    std::fs::read(dir.join("updates.json")).ok()
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .unwrap_or_default().channel
}
pub fn save_update_channel(dir: &Path, channel: crate::updates::Channel) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join("updates.json"), serde_json::to_vec(&serde_json::json!({"channel": channel}))?)
}

/// How much the producer already knows. It picks the terms the model may
/// assume, not how long the answer is: every level gets the same short answer.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Experience {
    NewToLive,
    /// Adds nothing to `SYSTEM_PROMPT`, so a producer who never chose gets
    /// the base prompt.
    #[default]
    FinishesTracks,
    MixesForOthers,
}

pub const PREFERENCES_FILE: &str = "preferences.json";

/// None until the producer has chosen, which is what keeps the setup step
/// open. Its own file for the same reason the update channel has one.
pub fn load_experience(dir: &Path) -> Option<Experience> {
    #[derive(Deserialize)]
    struct Preferences { experience: Experience }
    std::fs::read(dir.join(PREFERENCES_FILE)).ok()
        .and_then(|bytes| serde_json::from_slice::<Preferences>(&bytes).ok())
        .map(|p| p.experience)
}
pub fn save_experience(dir: &Path, experience: Experience) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    // Setup never asks again, so a torn file would silently drop her choice.
    crate::threads::write_atomically(
        &dir.join(PREFERENCES_FILE),
        &serde_json::json!({"experience": experience}).to_string(),
    )
}
