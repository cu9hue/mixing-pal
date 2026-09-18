import { Updates } from "../model/updates";

export function UpdatePanel({ updates }: { updates: Updates }) {
  const { view, installing } = updates;
  const working = installing || view.phase === "checking" || view.phase === "downloading";
  return <section aria-labelledby="updates-title" data-tauri-drag-region="false">
    <h3 id="updates-title" className="advanced__heading">App updates</h3>
    <label className="advanced__field">
      <span><input type="checkbox" checked={view.channel === "pilot"} disabled={working}
        onChange={(event) => void updates.channel(event.target.checked ? "pilot" : "stable")} /> Receive pilot updates</span>
    </label>
    <p className="advanced__note" role="status">
      {installing ? "Preparing to restart…" : view.phase === "checking" ? "Checking for updates…"
        : view.phase === "downloading" ? "Downloading update…" : view.version ? `Mixing Pal ${view.version}`
        : view.phase === "idle" ? "No update is selected for this channel." : "Could not check for updates."}
    </p>
    {view.notes && <p className="advanced__release-notes">{view.notes}</p>}
    {view.message && <p className="advanced__error" role="alert">{view.message}</p>}
    <button className="advanced__button" disabled={working} onClick={() => void updates.check()}>Check for updates</button>
    {view.phase === "available" && <button className="advanced__button" disabled={working}
      onClick={() => void updates.download()}>Download update</button>}
    {view.phase === "ready" && <button className="advanced__button" disabled={working}
      onClick={() => void updates.install()}>Install and restart Mixing Pal</button>}
  </section>;
}
