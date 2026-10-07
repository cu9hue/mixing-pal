import { Outcome, RatedExchange, clear, latestFor } from "../notes/outcomes";
import { OutcomeRow, RATING_LABELS } from "./OutcomeRow";
import "./MoveCheckin.css";

export function MoveBox({ exchange, outcomes, editing, sharingEnabled, onChange, onDone }: {
  exchange: RatedExchange;
  outcomes: Outcome[];
  editing: boolean;
  sharingEnabled: boolean;
  onChange: (next: Outcome[]) => boolean;
  onDone: () => void;
}) {
  const latest = latestFor(outcomes, exchange.turnId);
  return <div className="move-box" data-tauri-drag-region="false">
    <div className="move-box__label">Your move</div>
    <div className="move-box__text selectable">{exchange.move}</div>
    {!editing && latest !== null && <div className="move-box__result">
      {RATING_LABELS[latest.outcome]}{latest.heard !== "" && ` · “${latest.heard}”`}
    </div>}
    {editing && <OutcomeRow exchange={exchange} outcomes={outcomes} sharingEnabled={sharingEnabled} onChange={onChange}
      onDone={onDone}
      // In the box, "Didn't try" takes back an earlier rating.
      onSkip={() => { if (latest === null || onChange(clear(outcomes, exchange.turnId))) onDone(); }} />}
  </div>;
}
