import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Advanced.css";
import { Trace } from "./Trace";
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
 * Everything the producer should never need to see.
 *
 * The bring-your-own-key fields live here rather than in setup because
 * they are a pressure valve for a technical minority and for the day the
 * proxy is down -- not a step anybody is asked to complete.
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
  const [saving, setSaving] = useState(false);
  const [connector, setConnector] = useState<ConnectorView | null>(null);
  const [connectorNote, setConnectorNote] = useState<string | null>(null);
  const [reinstalling, setReinstalling] = useState(false);

  useEffect(() => {
    invoke<SettingsView>("get_settings").then(setView).catch(() => setView(null));
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

  if (view === null) return null;

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
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="advanced">
      <div className="advanced__note">
        Mixing Pal normally handles this for you. These fields point it at your own
        provider instead.
      </div>

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
          placeholder={view.has_key ? "stored — leave blank to keep" : "required"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>

      <button className="advanced__button" onClick={save} disabled={saving}>
        {saving ? "Checking the model…" : "Save"}
      </button>
      <button className="advanced__button" onClick={onClose} style={{ marginLeft: 6 }}>
        Cancel
      </button>

      {error !== null && <div className="advanced__error">{error}</div>}

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
        {connectorNote !== null && <div className="advanced__note">{connectorNote}</div>}
      </div>

      <div className="advanced__note">Mixing Pal v{appVersion}</div>

      <Trace />
    </div>
  );
}
