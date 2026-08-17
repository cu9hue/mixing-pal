import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface SettingsView {
  base_url: string;
  model: string;
  has_key: boolean;
}

export function Settings({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<SettingsView>("get_settings").then(setView).catch(() => setView(null));
  }, []);

  if (!view) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Rust probes before it persists: a model that cannot call tools is
      // refused here, with its own answer quoted back.
      const saved = await invoke<SettingsView>("save_settings", {
        baseUrl: view!.base_url,
        modelName: view!.model,
        // Empty means "keep the stored key" -- the pane never sees it.
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
    <div style={{ padding: 10, borderBottom: "1px solid #444" }}>
      <label style={{ display: "block", marginBottom: 6 }}>
        Base URL
        <input
          style={{ width: "100%" }}
          value={view.base_url}
          onChange={(e) => setView({ ...view, base_url: e.target.value })}
        />
      </label>
      <label style={{ display: "block", marginBottom: 6 }}>
        Model
        <input
          style={{ width: "100%" }}
          placeholder="moonshotai/kimi-k2"
          value={view.model}
          onChange={(e) => setView({ ...view, model: e.target.value })}
        />
      </label>
      <label style={{ display: "block", marginBottom: 6 }}>
        API key
        <input
          style={{ width: "100%" }}
          type="password"
          placeholder={view.has_key ? "stored — leave blank to keep" : "required"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      <button onClick={save} disabled={saving}>
        {saving ? "Checking the model…" : "Save"}
      </button>
      <button onClick={onClose} style={{ marginLeft: 6 }}>
        Cancel
      </button>
      {error && (
        <div style={{ background: "#7a2020", color: "white", padding: 8, marginTop: 8, whiteSpace: "pre-wrap" }}>
          {error}
        </div>
      )}
    </div>
  );
}
