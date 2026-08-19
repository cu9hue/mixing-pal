import { useState } from "react";
import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { loadGoal, saveGoal } from "./goal";
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
  onDismissNudge,
  onTurnRunningChange,
  onAnswer,
  onCollapse,
}: {
  state: SetState;
  lastSeen: number | null;
  connected: boolean;
  nudge: Nudge | null;
  onDismissNudge: (id: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onCollapse: () => void;
}) {
  const [goal, setGoal] = useState(loadGoal);

  return (
    <div className="card">
      <Header
        connected={connected}
        goal={goal}
        onGoalChange={(v) => {
          setGoal(v);
          saveGoal(v);
        }}
        onCollapse={onCollapse}
      />
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} />
      {nudge !== null && <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />}
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
