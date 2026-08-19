import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Advanced.css";
import { Trace } from "./Trace";

interface SettingsView {
  base_url: string;
  model: string;
  has_key: boolean;
}

/**
 * Everything the producer should never need to see.
 *
 * The bring-your-own-key fields live here rather than in setup because
 * they are a pressure valve for a technical minority and for the day the
 * proxy is down -- not a step anybody is asked to complete.
 */
export function Advanced({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<SettingsView>("get_settings").then(setView).catch(() => setView(null));
  }, []);

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

      <Trace />
    </div>
  );
}
