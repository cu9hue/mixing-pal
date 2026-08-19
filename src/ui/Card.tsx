import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { Header } from "./Header";
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
  onInputEmptyChange,
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
  onInputEmptyChange: (empty: boolean) => void;
  onShowSetup: () => void;
}) {
  return (
    <div className="card">
      <Header connected={connected} goal={goal} onGoalChange={onGoalChange} onCollapse={onCollapse} />
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} onShowSetup={onShowSetup} />
      {nudge !== null && connected && (
        <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />
      )}
      <Conversation
        state={state}
        goal={goal}
        onTurnRunningChange={onTurnRunningChange}
        onAnswer={onAnswer}
        onInputEmptyChange={onInputEmptyChange}
      />
      <WhatICanSee state={state} />
    </div>
  );
}
