import { Updates } from "../model/updates";

export function UpdatePanel({ updates }: { updates: Updates }) {
  const { view, installing } = updates;
  const working = installing || view.phase === "checking" || view.phase === "downloading";
  return <section className="updates" aria-labelledby="updates-title" data-tauri-drag-region="false">
    <div className="updates__header">
      <h3 id="updates-title" className="advanced__heading">App updates</h3>
      <button className="advanced__button updates__check" disabled={working} onClick={() => void updates.check()}>Check for updates</button>
    </div>
    <p className="updates__status" role="status">
      {installing ? "Preparing to restart…" : view.phase === "checking" ? "Checking for updates…"
        : view.phase === "downloading" ? `Downloading Mixing Pal ${view.version ?? "update"}…`
        : view.phase === "error" ? "Could not complete the update check or download." : view.version ? `Mixing Pal ${view.version}${view.phase === "ready" ? " is ready to install." : " is available."}`
        : view.phase === "idle" ? "No update is available for this channel." : "Could not check for updates."}
    </p>
    {view.message && <p className="advanced__error" role="alert">{view.message}</p>}
    <div className="updates__actions">
      {view.phase === "available" && <button className="advanced__button advanced__button--primary" disabled={working}
        onClick={() => void updates.download()}>Download update</button>}
      {view.phase === "ready" && <button className="advanced__button advanced__button--primary" disabled={working}
        onClick={() => void updates.install()}>Install and restart Mixing Pal</button>}
    </div>
    <label className="updates__channel">
      <input type="checkbox" checked={view.channel === "pilot"} disabled={working}
        onChange={(event) => void updates.channel(event.target.checked ? "pilot" : "stable")} />
      Receive pilot updates
    </label>
  </section>;
}
