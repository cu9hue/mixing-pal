import { Updates } from "../model/updates";
import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { SetupStep } from "../setup/step";
import { Header } from "./Header";
import { Noticed } from "./Noticed";
import { Conversation } from "./Conversation";
import { Connection } from "./Connection";
import { Advanced } from "./Advanced";
import { AccountState } from "../model/account";
import { ExperienceState } from "../model/experience";
import { AccountPanel } from "./AccountPanel";

export function Card({
  account,
  experience,
  updates,
  onOpenSettings,
  state,
  lastSeen,
  connected,
  nudge,
  onDismissNudge,
  onTurnRunningChange,
  onAnswer,
  onCollapse,
  onShowSetup,
  settingsOpen,
  onCloseSettings,
}: {
  account: AccountState;
  experience: ExperienceState;
  updates?: Updates;
  onOpenSettings?: () => void;
  state: SetState;
  lastSeen: number | null;
  connected: boolean;
  nudge: Nudge | null;
  onDismissNudge: (id: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onCollapse: () => void;
  onShowSetup: (step: SetupStep) => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
}) {
  const needsSignIn =
    account.view === null ||
    account.view.access === "signed_out" ||
    account.view.access === "invitation_required";

  // One drag mechanism for the whole card: everything inside drags the
  // window, except buttons, inputs, and summaries (Tauri blocks those
  // itself), the answer and error text she may want to select, and the
  // scrollable body's own box, so the scrollbar thumb still scrolls. Each
  // exchange opts back in. See dragRegions.test.ts.
  return (
    <div className="card" data-tauri-drag-region="deep">
      <Header connected={connected} onCollapse={onCollapse} showConnection={!needsSignIn} />
      {updates && (updates.view.phase === "available" || updates.view.phase === "ready") && !settingsOpen && <button className="advanced__button" onClick={onOpenSettings}>Update available · Open Settings</button>}
      {/* Settings replaces what is below the header, but hides it rather
          than unmounting it: the conversation and any answer in flight live
          in Conversation's state, the same reason App hides the card. */}
      {settingsOpen && (
        <div className="card__settings">
          <Advanced updates={updates} account={account} experience={experience} scriptVersion={state.scriptVersion} onClose={onCloseSettings} />
        </div>
      )}
      <div className={`card__main${settingsOpen ? " card__main--hidden" : ""}`}>
      {needsSignIn && <div className="card__account card__account--solo"><AccountPanel account={account} /></div>}
      <div className={`card__session${needsSignIn ? " card__session--hidden" : ""}`}>
      {!needsSignIn && <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} onShowSetup={onShowSetup} />}
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
      {/* Preserve the conversation through brief Live interruptions. */}
      <div className={`card__conversation${connected ? "" : " card__conversation--hidden"}`}>
        <Conversation
          account={account}
          connected={connected}
          state={state}
          onTurnRunningChange={onTurnRunningChange}
          onAnswer={onAnswer}
        />
      </div>
      </div>
      </div>
    </div>
  );
}
