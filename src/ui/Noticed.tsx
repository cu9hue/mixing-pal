import { Nudge } from "../rules/nudges";

/**
 * One nudge at a time, always dismissible. The accent rule down the left
 * is one of the two places the accent appears in this view; the other is
 * the unread pill. A third would be decoration.
 */
export function Noticed({ nudge, onDismiss }: { nudge: Nudge; onDismiss: () => void }) {
  return (
    <div className="card__noticed">
      <span className="card__noticed-rule" />
      <div className="card__noticed-body">
        <div className="card__label">Noticed</div>
        <div className="card__noticed-text">{nudge.text}</div>
      </div>
      <button className="card__dismiss" onClick={onDismiss} title="Dismiss">
        ×
      </button>
    </div>
  );
}
