import { useState } from "react";
import { GOAL_MAX_LENGTH } from "./goal";

/**
 * Three elements and nothing else: is it connected, what is she making,
 * and a way to close.
 *
 * No tempo, no key, no track count. Live shows all three, larger and more
 * accurately, and mirroring them would make this a worse copy of a window
 * that is already open. They live in the disclosure below, where the job
 * is proof rather than information.
 */
export function Header({
  connected,
  goal,
  onGoalChange,
  onCollapse,
}: {
  connected: boolean;
  goal: string;
  onGoalChange: (value: string) => void;
  onCollapse: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="card__header" data-tauri-drag-region>
      <span className={`card__dot ${connected ? "card__dot--ok" : "card__dot--error"}`} />
      {editing ? (
        <input
          className="card__goal-input"
          autoFocus
          value={goal}
          maxLength={GOAL_MAX_LENGTH}
          placeholder="What are you making?"
          onChange={(e) => onGoalChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
        />
      ) : (
        <button className="card__goal" onClick={() => setEditing(true)}>
          {goal.trim() === "" ? "What are you making?" : goal}
        </button>
      )}
      <button className="card__chevron" onClick={onCollapse} title="Collapse">
        ⌄
      </button>
    </div>
  );
}
