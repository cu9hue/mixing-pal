import { useBusyState, beginMutation } from "../model/updates";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** Every screen after "install" names the connector as Live shows it. */
export function InstallScreen({
  folder,
  onInstalled,
}: {
  folder: string;
  onInstalled: () => void;
}) {
  const operations = useBusyState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [library, setLibrary] = useState("");
  const [askingForLibrary, setAskingForLibrary] = useState(false);

  async function install() {
    if (!beginMutation(operations, "wireInstall")) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("install_connector", {
        userLibrary: askingForLibrary && library.trim() !== "" ? library.trim() : null,
      });
      onInstalled();
    } catch (e) {
      setError(String(e));
      // The one failure she can actually fix herself: we looked in the
      // usual place and her library is somewhere else.
      setAskingForLibrary(true);
    } finally {
      setBusy(false);
      operations.wireInstall = false;
    }
  }

  return (
    <>
      <div className="setup__label">Step 2 of 4</div>
      <h1 className="setup__title">Mixing Pal needs a small connector inside Live.</h1>
      <p className="setup__body">
        It goes into your Ableton User Library, where Live keeps the things you add
        yourself. Nothing else on your computer is touched.
      </p>
      {error !== null && <div className="setup__error">{error}</div>}
      {askingForLibrary && (
        <input
          className="setup__field"
          value={library}
          placeholder="/Users/you/Music/Ableton/User Library"
          onChange={(e) => setLibrary(e.target.value)}
        />
      )}
      <button className="setup__primary" onClick={install} disabled={busy || operations.install}>
        {busy ? "Installing…" : askingForLibrary ? "Try again" : "Install it"}
      </button>
      <p className="setup__note" style={{ marginTop: 14 }}>
        It will appear in Live as <b>{folder}</b>.
      </p>
    </>
  );
}

export function OpenLiveScreen() {
  return (
    <>
      <div className="setup__label">Step 3 of 4</div>
      <h1 className="setup__title">Now open Ableton Live.</h1>
      <p className="setup__body">
        Live only looks for connectors when it starts, so if it was already open,
        quit it and open it again.
      </p>
      <div className="setup__waiting">
        <span className="setup__waiting-dot" />
        Waiting for Live…
      </div>
    </>
  );
}

export function ControlSurfaceScreen({ folder }: { folder: string }) {
  return (
    <>
      <div className="setup__label">Step 4 of 4</div>
      <h1 className="setup__title">Turn it on inside Live.</h1>
      <p className="setup__body">
        Open Live's <b>Settings → Link, Tempo &amp; MIDI</b> (called{" "}
        <b>Preferences</b> in Live 12.0 and earlier), and choose <b>{folder}</b> as a
        Control Surface.
      </p>
      <img
        className="setup__shot"
        src="/control-surface.png"
        alt={`Live's Link, Tempo and MIDI settings, with ${folder} chosen as a Control Surface and Input and Output left as None`}
      />
      {/* The thing people get wrong, and the reason this screen has a
          callout rather than just a picture. */}
      <div className="setup__callout">Leave Input and Output set to None.</div>
      <div className="setup__waiting">
        <span className="setup__waiting-dot" />
        Waiting for Live to say hello…
      </div>
      <p className="setup__note" style={{ marginTop: 14 }}>
        If you just installed the connector and {folder} isn't in the list, quit Live and
        open it again — it only looks for connectors at startup.
      </p>
    </>
  );
}

export function ConnectedScreen({
  trackCount,
  trackNames,
  onContinue,
}: {
  trackCount: number;
  trackNames: string[];
  onContinue: () => void;
}) {
  const named = trackNames.filter((n) => n.trim() !== "").slice(0, 4);
  return (
    <>
      <div className="setup__label">Step 4 of 4</div>
      <h1 className="setup__title">
        <span className="setup__ok-dot" />
        Connected.
      </h1>
      {/* Proof, and the moment the setup pays for itself. This is the one
          place in the product where mirroring Live earns its keep. */}
      <p className="setup__body">
        I can see <b>{trackCount} {trackCount === 1 ? "track" : "tracks"}</b>
        {named.length > 0 && <> — {named.join(", ")}…</>}
      </p>
      {/* Required copy, not decoration. The product is called Mixing Pal
          and it cannot hear audio; this is the one screen that says so
          before she forms an expectation it cannot meet. Do not shorten
          this, and do not move it into fine print. */}
      <p className="setup__body">
        I read your settings — devices, faders, routing, notes. I can't hear your audio,
        so I'll never tell you something sounds muddy. I'll tell you what's set to what,
        and what that usually means.
      </p>
      <button className="setup__primary" onClick={onContinue}>
        Got it
      </button>
    </>
  );
}
