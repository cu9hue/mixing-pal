import { Outcome, RatedExchange } from "../notes/outcomes";
import { OutcomeRow } from "./OutcomeRow";
import "./MoveCheckin.css";

export function MoveCheckin({ exchange, outcomes, sharingEnabled, onChange, onClose }: {
  exchange: RatedExchange;
  outcomes: Outcome[];
  sharingEnabled: boolean;
  onChange: (next: Outcome[]) => boolean;
  onClose: () => void;
}) {
  // No move text: the check-in is always about the answer just above.
  return <section className="checkin" aria-label="How did the last move go?" data-tauri-drag-region="false">
    <OutcomeRow exchange={exchange} outcomes={outcomes} sharingEnabled={sharingEnabled}
      question="How did the last move go?" onChange={onChange} onSkip={onClose} onDone={onClose} />
  </section>;
}
