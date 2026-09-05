import { useState } from "react";
import { GOAL_MAX_LENGTH } from "./goal";

/**
 * The goal in its own row: a label, her words, and a pencil. It used to be
 * the header's one line of dim text, which read as a window title -- nothing
 * said what it was or that a click would edit it.
 *
 * The row drags the window through the card's deep drag region. Tauri
 * blocks the drag on the button and the input itself, so a click on her
 * words edits and a click beside them moves.
 */
export function GoalRow({
  goal,
  onGoalChange,
}: {
  goal: string;
  onGoalChange: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const empty = goal.trim() === "";

  return (
    <div className="card__goal-row">
      <span className="card__label card__goal-label">Goal</span>
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
        <button
          className={`card__goal${empty ? " card__goal--empty" : ""}`}
          onClick={() => setEditing(true)}
          title="Edit the goal"
        >
          <span className="card__goal-text">{empty ? "What are you making?" : goal}</span>
          <span className="card__goal-pencil" aria-hidden="true">
            ✎
          </span>
        </button>
      )}
    </div>
  );
}
