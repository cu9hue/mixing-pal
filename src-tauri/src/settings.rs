use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// OpenRouter. Chosen because it standardises the tool-calling interface
/// across providers and exposes a filter for models that support it, so one
/// OpenAI-compatible adapter reaches a wide model set. The same adapter
/// reaches LM Studio, Ollama, and OpenAI by changing this value alone --
/// which is why it is a setting, not a constant in the client.
pub const DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

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
            model: String::new(),
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
pub fn load(dir: &Path) -> Settings {
    std::fs::read_to_string(dir.join(SETTINGS_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
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
            "ableton-copilot-settings-{}-{}",
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
        assert!(loaded.model.is_empty());
        assert!(loaded.api_key.is_empty());
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
