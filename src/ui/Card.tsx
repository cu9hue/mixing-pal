import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { SetupStep } from "../setup/step";
import { Header } from "./Header";
import { GoalRow } from "./GoalRow";
import { Noticed } from "./Noticed";
import { Conversation } from "./Conversation";
import { WhatICanSee } from "./WhatICanSee";
import { Connection } from "./Connection";

export function Card({
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
}: {
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
}) {
  // One drag mechanism for the whole card: everything inside drags the
  // window, except buttons, inputs, and summaries (Tauri blocks those
  // itself), the answer and error text she may want to select, and the
  // scrollable body's own box, so the scrollbar thumb still scrolls. Each
  // exchange opts back in. See dragRegions.test.ts.
  return (
    <div className="card" data-tauri-drag-region="deep">
      <Header connected={connected} onCollapse={onCollapse} />
      <GoalRow goal={goal} onGoalChange={onGoalChange} />
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} onShowSetup={onShowSetup} />
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
      <Conversation
        state={state}
        goal={goal}
        onTurnRunningChange={onTurnRunningChange}
        onAnswer={onAnswer}
      />
      <WhatICanSee state={state} />
    </div>
  );
}
