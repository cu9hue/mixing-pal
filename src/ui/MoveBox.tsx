import { useEffect, useRef } from "react";
import { Outcome, RatedExchange, clear, latestFor } from "../notes/outcomes";
import { OutcomeRow, RATING_LABELS } from "./OutcomeRow";
import "./MoveCheckin.css";

/** Under an answer: nothing until rated, then one quiet line. The answer's own Move line names the move. */
export function MoveBox({ exchange, outcomes, editing, sharingEnabled, onChange, onDone }: {
  exchange: RatedExchange;
  outcomes: Outcome[];
  editing: boolean;
  sharingEnabled: boolean;
  onChange: (next: Outcome[]) => boolean;
  onDone: () => void;
}) {
  const latest = latestFor(outcomes, exchange.turnId);
  const root = useRef<HTMLDivElement>(null);
  // The menu item that opened this is gone; keep a keyboard user on the choices.
  useEffect(() => {
    if (!editing) return;
    const pressed = root.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]');
    (pressed ?? root.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [editing]);
  if (!editing && latest === null) return null;
  return <div className="move-result" ref={root} data-tauri-drag-region="false">
    {!editing && latest !== null && <>
      {RATING_LABELS[latest.outcome]}{latest.heard !== "" && ` · “${latest.heard}”`}
    </>}
    {editing && <OutcomeRow exchange={exchange} outcomes={outcomes} sharingEnabled={sharingEnabled} onChange={onChange}
      onDone={onDone}
      // Here "Didn't try" takes back an earlier rating.
      onSkip={() => { if (latest === null || onChange(clear(outcomes, exchange.turnId))) onDone(); }} />}
  </div>;
}
