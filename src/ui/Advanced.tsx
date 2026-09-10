import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Advanced.css";
import wireVersion from "../../shared/wire-version.json";
import { version as appVersion } from "../../package.json";

interface SettingsView {
  base_url: string;
  model: string;
  has_key: boolean;
}

interface ConnectorView {
  folder: string;
  installed: boolean;
}

/**
 * Settings, reached from the app menu: the model the app calls and the
 * harness inside Live. The bring-your-own-key fields live here rather than
 * in setup because they are a pressure valve for a technical minority and
 * for the day the proxy is down -- not a step anybody is asked to complete.
 * Debug views (the trace, the tracks the model sees) are not settings and
 * stay under "What I can see".
 */
export function Advanced({
  scriptVersion,
  onClose,
}: {
  scriptVersion: number | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Distinct from `view === null`, which also means "still loading". Folding
  // the two together is what left this pane blank with no way out.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Saving used to close the pane, which was the only sign it had worked.
  // The pane stays; the sign is a word.
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [connector, setConnector] = useState<ConnectorView | null>(null);
  const [connectorNote, setConnectorNote] = useState<string | null>(null);
  const [reinstalling, setReinstalling] = useState(false);

  useEffect(() => {
    invoke<SettingsView>("get_settings")
      .then(setView)
      .catch((e) => setLoadError(String(e)));
    invoke<ConnectorView>("connector_status").then(setConnector).catch(() => setConnector(null));
  }, []);

  async function reinstall() {
    setReinstalling(true);
    setConnectorNote(null);
    try {
      await invoke("install_connector", { userLibrary: null });
      // Live reads Remote Scripts once, at startup, so the copy alone
      // changes nothing she can see.
      setConnectorNote("Reinstalled. Quit Live and open it again.");
      invoke<ConnectorView>("connector_status").then(setConnector).catch(() => {});
    } catch (e) {
      setConnectorNote(String(e));
    } finally {
      setReinstalling(false);
    }
  }

  // Returning null here rendered an empty box with no Cancel button and no
  // way back to the card. This is the pane that exists for the day the
  // provider is unreachable, so failing to open is precisely when it must
  // still offer a way out.
  if (view === null) {
    return (
      <div className="advanced">
        {loadError === null ? (
          <div className="advanced__note">Reading your settings…</div>
        ) : (
          <div className="advanced__error">{`Couldn't read your settings.\n${loadError}`}</div>
        )}
        <button className="advanced__button" onClick={onClose}>
          Close
        </button>
      </div>
    );
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Rust probes before it persists: a model that cannot call tools is
      // refused here, with its own answer quoted back.
      const saved = await invoke<SettingsView>("save_settings", {
        baseUrl: view!.base_url,
        modelName: view!.model,
        // Empty means "keep the stored key" -- this pane never sees it.
        apiKey: key,
      });
      setView(saved);
      setKey("");
      setSavedNote("Saved.");
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="advanced">
      {/* The one way back that is on screen. Escape is the other. */}
      <div className="advanced__titlebar">
        <h2 className="advanced__title">Settings</h2>
        <button className="advanced__button" onClick={onClose} title="Back to the set (Esc)">
          Done
        </button>
      </div>

      <h3 className="advanced__heading">Model settings</h3>

      <label className="advanced__field">
        <span className="advanced__label">Base URL</span>
        <input
          className="advanced__input"
          value={view.base_url}
          onChange={(e) => setView({ ...view, base_url: e.target.value })}
        />
      </label>

      <label className="advanced__field">
        <span className="advanced__label">Model</span>
        <input
          className="advanced__input"
          placeholder="moonshotai/kimi-k2"
          value={view.model}
          onChange={(e) => setView({ ...view, model: e.target.value })}
        />
      </label>

      <label className="advanced__field">
        <span className="advanced__label">API key</span>
        <input
          className="advanced__input"
          type="password"
          placeholder={view.has_key ? "stored, leave blank to keep" : "required"}
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>

      <button className="advanced__button" onClick={save} disabled={saving}>
        {saving ? "Checking the model…" : "Save"}
      </button>
      {savedNote !== null && error === null && (
        <span className="advanced__saved" aria-live="polite">
          {savedNote}
        </span>
      )}

      {error !== null && (
        <div className="advanced__error" role="alert">
          {error}
        </div>
      )}

      <h3 className="advanced__heading">Harness settings</h3>

      <div className="advanced__field">
        <span className="advanced__label">Connector</span>
        <div className="advanced__value">
          {connector === null
            ? "—"
            : connector.installed
              ? `${connector.folder}, v${scriptVersion ?? "not reporting"}`
              : `${connector.folder}, not installed`}
          {" · this app expects v"}
          {wireVersion.version}
        </div>
        <button className="advanced__button" onClick={reinstall} disabled={reinstalling}>
          {reinstalling ? "Reinstalling…" : "Reinstall"}
        </button>
        {connectorNote !== null && (
          <div className="advanced__hint" aria-live="polite">
            {connectorNote}
          </div>
        )}
      </div>

      <div className="advanced__note">Mixing Pal v{appVersion}</div>
    </div>
  );
}
