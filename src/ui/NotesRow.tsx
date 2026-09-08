import { useState } from "react";
import { BULLET_KINDS, BULLET_MAX_CHARS, BulletKind, Note, addBullet, deleteBullet, editBullet } from "../notes/note";

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
 * The set's note, above the thread: what she tried, what she heard, what
 * she decided. Collapsed by default; the summary's count is the one thing
 * that moves when the model adds a bullet. A bullet she has not touched is
 * dim; editing or adding makes it hers, and hers the model cannot retire.
 */
export function NotesRow({ note, onChange }: { note: Note; onChange: (next: Note) => void }) {
  const [open, setOpen] = useState(loadOpen);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [kind, setKind] = useState<BulletKind>("heard");
  const [adding, setAdding] = useState("");

  function commitEdit(id: string) {
    onChange(editBullet(note, id, draft, now()));
    setEditing(null);
  }

  function add() {
    if (adding.trim() === "") return;
    onChange(addBullet(note, kind, adding, true, now()));
    setAdding("");
  }

  return (
    <details
      className="notes"
      open={open}
      onToggle={(e) => {
        const isOpen = e.currentTarget.open;
        setOpen(isOpen);
        saveOpen(isOpen);
      }}
    >
      <summary className="notes__summary">Notes · {note.bullets.length}</summary>
      <div className="notes__panel" data-tauri-drag-region="false">
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
                onBlur={() => commitEdit(b.id)}
                onKeyDown={(e) => e.key === "Enter" && commitEdit(b.id)}
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
            <button className="notes__delete" title="Delete" onClick={() => onChange(deleteBullet(note, b.id))}>
              ×
            </button>
          </div>
        ))}
        <div className="notes__add">
          <select className="notes__kind-pick" value={kind} onChange={(e) => setKind(e.target.value as BulletKind)}>
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
    </details>
  );
}
