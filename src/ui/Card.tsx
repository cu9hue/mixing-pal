import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { SetupStep } from "../setup/step";
import { Header } from "./Header";
import { Noticed } from "./Noticed";
import { Conversation } from "./Conversation";
import { WhatICanSee } from "./WhatICanSee";
import { Connection } from "./Connection";
import { Advanced } from "./Advanced";
import { AccountState, canAsk } from "../model/account";
import { AccountPanel } from "./AccountPanel";

export function Card({
  account,
  state,
  lastSeen,
  connected,
  nudge,
  goal,
  onGoalChange,
  onDismissNudge,
  onTurnRunningChange,
  onAnswer,
  onCollapse,
  onShowSetup,
  settingsOpen,
  onCloseSettings,
}: {
  account: AccountState;
  state: SetState;
  lastSeen: number | null;
  connected: boolean;
  nudge: Nudge | null;
  goal: string;
  onGoalChange: (value: string) => void;
  onDismissNudge: (id: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onCollapse: () => void;
  onShowSetup: (step: SetupStep) => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;
}) {
  // One drag mechanism for the whole card: everything inside drags the
  // window, except buttons, inputs, and summaries (Tauri blocks those
  // itself), the answer and error text she may want to select, and the
  // scrollable body's own box, so the scrollbar thumb still scrolls. Each
  // exchange opts back in. See dragRegions.test.ts.
  return (
    <div className="card" data-tauri-drag-region="deep">
      <Header connected={connected} onCollapse={onCollapse} />
      {/* Settings replaces what is below the header, but hides it rather
          than unmounting it: the conversation and any answer in flight live
          in Conversation's state, the same reason App hides the card. */}
      {settingsOpen && (
        <div className="card__settings">
          <Advanced account={account} scriptVersion={state.scriptVersion} onClose={onCloseSettings} />
        </div>
      )}
      <div className={`card__main${settingsOpen ? " card__main--hidden" : ""}`}>
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} onShowSetup={onShowSetup} />
      {!canAsk(account.view) && <div className="card__account"><AccountPanel account={account} /></div>}
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
      <Conversation
        account={account}
        state={state}
        goal={goal}
        onGoalChange={onGoalChange}
        onTurnRunningChange={onTurnRunningChange}
        onAnswer={onAnswer}
      />
      <WhatICanSee state={state} />
      </div>
    </div>
  );
}
