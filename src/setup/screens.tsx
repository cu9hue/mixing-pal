import { useBusyState, beginMutation } from "../model/updates";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { EXPERIENCES, ExperienceState } from "../model/experience";
import { AccountState, AccountView, errorMessage } from "../model/account";

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
      // The one failure the producer can actually fix themselves: we looked in the
      // usual place and their library is somewhere else.
      setAskingForLibrary(true);
    } finally {
      setBusy(false);
      operations.wireInstall = false;
    }
  }

  return (
    <>
      <div className="setup__label">Step 2 of 4</div>
      <h1 className="setup__title">Add Mixing Pal to Live.</h1>
      <p className="setup__body">
        It's a small connector that goes in your Ableton User Library. Nothing else on
        your computer changes.
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
        {busy ? "Installing…" : askingForLibrary ? "Try again" : "Install the connector"}
      </button>
      <p className="setup__note" style={{ marginTop: 14 }}>
        It shows up in Live as <b>{folder}</b>.
      </p>
    </>
  );
}

export function OpenLiveScreen() {
  return (
    <>
      <div className="setup__label">Step 2 of 4</div>
      <h1 className="setup__title">Now open Ableton Live.</h1>
      <p className="setup__body">
        Live only looks for new connectors when it starts. If Live is open, quit it
        and open it again.
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
      <div className="setup__label">Step 2 of 4</div>
      <h1 className="setup__title">Turn it on in Live.</h1>
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
        Waiting for Live to connect…
      </div>
      <p className="setup__note" style={{ marginTop: 14 }}>
        Is {folder} missing from the list? Quit Live and open it again.
      </p>
    </>
  );
}

export function ConnectedScreen({
  trackCount,
  trackNames,
  experience,
}: {
  trackCount: number;
  trackNames: string[];
  experience: ExperienceState;
}) {
  const named = trackNames.filter((n) => n.trim() !== "").slice(0, 4);
  return (
    <>
      <div className="setup__label">Step 3 of 4</div>
      <h1 className="setup__title">
        <span className="setup__ok-dot" />
        Connected.
      </h1>
      {/* Proof, and the moment the setup pays for itself. This is the one
          place in the product where mirroring Live earns its keep. */}
      <p className="setup__body">
        I can see <b>{trackCount} {trackCount === 1 ? "track" : "tracks"}</b>
        {named.length > 0 && <>: {named.join(", ")}…</>}
      </p>
      {/* Required copy, not decoration. The product is called Mixing Pal
          and it cannot hear audio; this is the one screen that says so
          before the producer forms an expectation it cannot meet. Do not shorten
          this, and do not move it into fine print. */}
      <p className="setup__body">
        I read your settings: devices, faders, routing and notes. I can't hear your audio,
        so I'll never tell you something sounds muddy. I'll tell you what's set to what,
        and what that usually means.
      </p>
      {/* Picking a level is how the producer moves on; it finishes setup. */}
      <h2 className="setup__question">How do you work in Live?</h2>
      <p className="setup__body">This sets which words I use. You can change it later in Settings.</p>
      <div className="setup__choices">
        {EXPERIENCES.map((option) => (
          <button
            key={option.value}
            className="setup__choice"
            onClick={() => void experience.choose(option.value)}
          >
            <span className="setup__choice-label">{option.label}</span>
            <span className="setup__choice-hint">{option.hint}</span>
          </button>
        ))}
      </div>
      {experience.error !== null && <div className="setup__error">{experience.error}</div>}
    </>
  );
}

export function SharingScreen({ account }: { account: AccountState }) {
  const operations = useBusyState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function choose(enabled: boolean) {
    if (!beginMutation(operations, "accountMutation")) return;
    setBusy(true);
    setError(null);
    try {
      account.change(await invoke<AccountView>("account_consent", { enabled }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      operations.accountMutation = false;
    }
  }

  return (
    <>
      <div className="setup__label">Step 4 of 4</div>
      <h1 className="setup__title">Help make my advice better?</h1>
      <p className="setup__body">
        If you share, a person on our team reads your questions, what I read in your set, my
        answers, and what you tell me about them. We delete them after 30 days. We never use
        them to train AI.
      </p>
      <p className="setup__body">You can change this, or delete what you shared, in Settings.</p>
      <div className="setup__choices">
        <button className="setup__choice" disabled={busy} onClick={() => void choose(true)}>
          <span className="setup__choice-label">Share</span>
          <span className="setup__choice-hint">Kept for 30 days, then deleted.</span>
        </button>
        <button className="setup__choice" disabled={busy} onClick={() => void choose(false)}>
          <span className="setup__choice-label">Don't share</span>
          <span className="setup__choice-hint">Nothing is kept for review.</span>
        </button>
      </div>
      {error !== null && <div className="setup__error">{error}</div>}
    </>
  );
}
