import { useState } from "react";
import { GOAL_MAX_LENGTH } from "./goal";
import { BULLET_KINDS, BULLET_MAX_CHARS, Bullet, BulletKind, Note, addBullet, deleteBullet, editBullet } from "../notes/note";

// Same persistence pattern as the disclosure: survive a webview reload, and
// never let a storage failure take the component down with it.
const OPEN_KEY = "copilot.notesOpen";

function loadOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "1";
  } catch {
    return false;
  }
}

function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? "1" : "0");
  } catch {
    // Best-effort only; see loadOpen.
  }
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The set's own row, under the header: the goal she wrote on the left and
 * a chip with the note count on the right, which opens the bullet list
 * beneath. Two things about the same set, one row. The goal used to be a
 * row of its own and the notes a disclosure line under it.
 *
 * The goal is a single-line field: it never wraps, an ellipsis cuts it in
 * display, and the input scrolls with the caret while she types. It gives
 * way before the chip does, and a gap keeps the ellipsis off the count.
 *
 * The row drags the window through the card's deep drag region. Tauri
 * blocks the drag on the buttons and the inputs themselves, so a click on
 * her words edits, a click on the chip opens, and a click beside them
 * moves. The list opts out so its scrollbar scrolls.
 */
export function SetRow({
  goal,
  onGoalChange,
  note,
  onNoteChange,
}: {
  goal: string;
  onGoalChange: (value: string) => void;
  note: Note;
  onNoteChange: (next: Note) => boolean;
}) {
  const [editingGoal, setEditingGoal] = useState(false);
  const empty = goal.trim() === "";
  const [open, setOpen] = useState(loadOpen);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<BulletKind>("heard");
  const [adding, setAdding] = useState("");

  function toggle() {
    const next = !open;
    setOpen(next);
    saveOpen(next);
  }

  // Opening the editor and leaving is not an edit: only a changed text
  // makes the bullet hers and moves its time.
  function commitEdit(b: Bullet) {
    if (draft.trim() !== b.text && !onNoteChange(editBullet(note, b.id, draft, now()))) return;
    setEditing(null);
  }

  function add() {
    if (adding.trim() === "") return;
    if (!onNoteChange(addBullet(note, kind, adding, true, now()))) return;
    setAdding("");
  }

  return (
    <div className="set-row">
      <div className="card__goal-row">
        <label htmlFor="goal" className="card__label card__goal-label">
          Goal
        </label>
        {editingGoal || empty ? (
          <input
            id="goal"
            className="card__goal-input"
            autoFocus={editingGoal}
            value={goal}
            maxLength={GOAL_MAX_LENGTH}
            placeholder="What are you making?"
            onFocus={() => setEditingGoal(true)}
            onChange={(e) => onGoalChange(e.target.value)}
            onBlur={() => setEditingGoal(false)}
            onKeyDown={(e) => e.key === "Enter" && setEditingGoal(false)}
          />
        ) : (
          <button
            className={`card__goal${empty ? " card__goal--empty" : ""}`}
            onClick={() => setEditingGoal(true)}
            title="Edit the goal"
          >
            <span className="card__goal-text">{empty ? "What are you making?" : goal}</span>
            <span className="card__goal-pencil" aria-hidden="true">
              ✎
            </span>
          </button>
        )}
        <button
          className={`notes__chip${open ? " notes__chip--open" : ""}`}
          onClick={toggle}
          aria-expanded={open}
          aria-controls="notes-panel"
          title={open ? "Hide the notes" : "Show the notes"}
        >
          Notes · {note.bullets.length}
        </button>
      </div>
      {open && (
        <div id="notes-panel" className="notes__panel" data-tauri-drag-region="false">
          {note.bullets.map((b) => (
            <div key={b.id} className={`notes__bullet${b.hers ? "" : " notes__bullet--model"}`}>
              <span className="notes__kind">{b.kind}</span>
              {editing === b.id ? (
                <input
                  className="notes__input"
                  autoFocus
                  value={draft}
                  maxLength={BULLET_MAX_CHARS}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitEdit(b)}
                  onKeyDown={(e) => e.key === "Enter" && commitEdit(b)}
                />
              ) : (
                <button
                  className="notes__text"
                  title="Edit"
                  onClick={() => {
                    setDraft(b.text);
                    setEditing(b.id);
                  }}
                >
                  {b.text}
                </button>
              )}
              <button className="notes__delete" title="Delete" onClick={() => onNoteChange(deleteBullet(note, b.id))}>
                ×
              </button>
            </div>
          ))}
          <div className="notes__add">
            <select
              className="notes__kind-pick"
              aria-label="Note kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as BulletKind)}
            >
              {BULLET_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              className="notes__input"
              value={adding}
              maxLength={BULLET_MAX_CHARS}
              placeholder="Add a note…"
              onChange={(e) => setAdding(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
