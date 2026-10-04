import { ReportHistory } from "./ReportProblem";
import { ReportTarget } from "../model/reports";
import { UpdatePanel } from "./UpdatePanel";
import { Updates } from "../model/updates";
import { useBusyState, beginMutation } from "../model/updates";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Advanced.css";
import wireVersion from "../../shared/wire-version.json";
import { version as appVersion } from "../../package.json";
import { AccountState } from "../model/account";
import { AccountPanel } from "./AccountPanel";
import { EXPERIENCES, ExperienceState } from "../model/experience";

interface SettingsView {
  base_url: string;
  model: string;
  has_key: boolean;
}

interface ConnectorView {
  folder: string;
  installed: boolean;
}

// Development builds expose provider settings for direct-provider testing.
// Public builds keep account access as the only model transport.
export function Advanced({
  account,
  experience,
  updates,
  scriptVersion,
  onClose,
  onReport,
}: {
  account: AccountState;
  /** App's, so a choice made here also ends the setup step. */
  experience: ExperienceState;
  updates?: Updates;
  scriptVersion: number | null;
  onClose: () => void;
  onReport?: (target: ReportTarget) => void;
}) {
  const operations = useBusyState();
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
    if (!beginMutation(operations, "wireInstall")) return;
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
      operations.wireInstall = false;
    }
  }

  async function save() {
    if (!beginMutation(operations, "settingsSave")) return;
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
      operations.settingsSave = false;
    }
  }

  return (
    <div className="advanced">
      <div className="advanced__titlebar">
        <h2 className="advanced__title">Settings</h2>
      </div>

      <div className="advanced__body" data-tauri-drag-region="false">
      {updates && <UpdatePanel updates={updates} />}
      {view === null ? (
        <div className={loadError === null ? "advanced__note" : "advanced__error"} role="status">
          {loadError === null ? "Reading your settings…" : `Couldn't read your settings.\n${loadError}`}
        </div>
      ) : <>
      <AccountPanel account={account} />

      <h3 className="advanced__heading">Answers</h3>
      <div className="advanced__choices" role="radiogroup" aria-label="How you work in Live">
        {EXPERIENCES.map((option) => (
          <label key={option.value} className="advanced__choice">
            <input
              type="radio"
              name="experience"
              // Before she chooses, answers use the default level.
              checked={(experience.experience ?? "finishes_tracks") === option.value}
              disabled={operations.install}
              onChange={() => void experience.choose(option.value)}
            />
            <span>
              {option.label}
              <span className="advanced__choice-hint">{option.hint}</span>
            </span>
          </label>
        ))}
        {experience.error !== null && (
          <div className="advanced__error" role="alert">
            {experience.error}
          </div>
        )}
      </div>
      {account.view?.access === "development" && <>
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
          placeholder="minimax/minimax-m3"
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

      <button className="advanced__button" onClick={save} disabled={saving || operations.install}>
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
      </>}

      <h3 className="advanced__heading">Live connector</h3>

      <div className="advanced__field">
        <div className="advanced__value">
          {connector === null
            ? "—"
            : connector.installed
              ? `${connector.folder}, v${scriptVersion ?? "not reporting"}`
              : `${connector.folder}, not installed`}
          {" · this app expects v"}
          {wireVersion.version}
        </div>
        <button className="advanced__button" onClick={reinstall} disabled={reinstalling || operations.install}>
          {reinstalling ? "Reinstalling…" : "Reinstall"}
        </button>
        {connectorNote !== null && (
          <div className="advanced__hint" aria-live="polite">
            {connectorNote}
          </div>
        )}
      </div>

      </>}
      {onReport && <section className="report-support" aria-label="Support">
        <h3 className="advanced__heading">Support</h3>
        <button className="report-link" disabled={operations.install} onClick={(event) => { event.currentTarget.focus(); onReport({ origin: "settings" }); }}>Report a problem</button>
        <ReportHistory key={account.view?.id} />
      </section>}
      </div>
      <div className="advanced__footer">
        <span className="advanced__version">Mixing Pal v{appVersion}</span>
        <button className="advanced__button" onClick={onClose} title="Back to the set (Esc)">
          Done
        </button>
      </div>
    </div>
  );
}
