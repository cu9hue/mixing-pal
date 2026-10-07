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
  return <section className="checkin" aria-label="How did the last move go?" data-tauri-drag-region="false">
    <div className="checkin__title">How did the last move go?</div>
    <div className="checkin__move">{exchange.move}</div>
    <OutcomeRow exchange={exchange} outcomes={outcomes} sharingEnabled={sharingEnabled} onChange={onChange}
      onSkip={onClose} onDone={onClose} />
  </section>;
}
