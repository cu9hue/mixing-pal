import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { beginMutation, useBusyState } from "../model/updates";
import { OUTCOME_TEXT_MAX_CHARS, Outcome, RatedExchange, Rating, clear, latestFor, rate, setHeard } from "../notes/outcomes";
import "./OutcomeRow.css";

export const RATING_LABELS: Record<Rating, string> = { kept: "Kept it", undone: "Undid it" };

export function OutcomeRow({ exchange, outcomes, sharingEnabled, question, onChange, onSkip, onDone }: {
  exchange: RatedExchange;
  outcomes: Outcome[];
  sharingEnabled: boolean;
  /** Shown above the choices; the heard prompt takes its place. */
  question?: string;
  onChange: (next: Outcome[]) => boolean;
  onSkip?: () => void;
  onDone?: () => void;
}) {
  const operations = useBusyState();
  const id = useId();
  const latest = latestFor(outcomes, exchange.turnId);
  const [hearing, setHearing] = useState(false);
  const [draft, setDraft] = useState("");
  const [shareFailed, setShareFailed] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Escape closes without saving; the blur that follows must not save either.
  const escaping = useRef(false);
  // Shares go out in order: a heard text saved while the rating's share is
  // still in flight would otherwise find the mutation slot taken.
  const sharing = useRef<Promise<void> | null>(null);

  useEffect(() => { if (hearing) escaping.current = false; }, [hearing]);

  function share(outcome: Rating, heard: string) {
    if (!sharingEnabled) return;
    const next = sharing.current ? sharing.current.then(() => send(outcome, heard)) : send(outcome, heard);
    sharing.current = next;
    void next.finally(() => { if (sharing.current === next) sharing.current = null; });
  }

  async function send(outcome: Rating, heard: string) {
    if (!beginMutation(operations, "accountMutation")) { setShareFailed(true); return; }
    try {
      await invoke("turn_feedback", { turnId: exchange.turnId, feedback: { id: crypto.randomUUID(), outcome, heard } });
      setShareFailed(false);
    } catch {
      setShareFailed(true);
    } finally {
      operations.accountMutation = false;
    }
  }

  function choose(outcome: Rating) {
    if (latest?.outcome === outcome) {
      if (onChange(clear(outcomes, exchange.turnId))) { setHearing(false); onDone?.(); }
      return;
    }
    if (!onChange(rate(outcomes, exchange, outcome, Math.floor(Date.now() / 1000)))) return;
    setDraft("");
    setHearing(true);
    // After an undo the reason is what makes the record useful.
    if (outcome === "undone") requestAnimationFrame(() => field.current?.focus());
    share(outcome, "");
  }

  function saveHeard() {
    if (!hearing) return;
    setHearing(false);
    const text = draft.trim();
    if (latest !== null && text !== latest.heard && onChange(setHeard(outcomes, exchange.turnId, text))) {
      share(latest.outcome, text);
    }
    onDone?.();
  }

  function closeHeard() {
    escaping.current = true;
    setHearing(false);
    onDone?.();
  }

  return <div className="outcome" data-tauri-drag-region="false">
    {!hearing && question && <div className="outcome__question">{question}</div>}
    {!hearing && <div className="outcome__choices">
      {(["kept", "undone"] as const).map((o) => (
        <button key={o} type="button" className="outcome__choice" aria-pressed={latest?.outcome === o}
          disabled={operations.install} onClick={() => choose(o)}>{RATING_LABELS[o]}</button>
      ))}
      {onSkip && <button type="button" className="outcome__choice" disabled={operations.install}
        onClick={onSkip}>Didn't try</button>}
    </div>}
    {hearing && latest !== null && <div className="outcome__heard-row">
      <div className="outcome__prompt" id={`${id}-prompt`}>
        {RATING_LABELS[latest.outcome]}. What did you hear? <span className="outcome__optional">(optional)</span>
      </div>
      <div className="outcome__heard-line">
        <input ref={field} className="outcome__heard" aria-label="What did you hear?" aria-describedby={`${id}-prompt`}
          placeholder="What did you hear?" maxLength={OUTCOME_TEXT_MAX_CHARS} value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); saveHeard(); }
            // Escape steps back out of the field only, not out of the card.
            else if (e.key === "Escape") { e.stopPropagation(); closeHeard(); }
          }}
          onBlur={() => { if (!escaping.current) saveHeard(); }} />
        {/* Keeps focus in the field, so the click saves once rather than racing the blur. */}
        <button type="button" className="outcome__save" onMouseDown={(e) => e.preventDefault()}
          onClick={saveHeard}>Save</button>
      </div>
    </div>}
    {shareFailed && <p className="outcome__status" role="status">Couldn't share this outcome.</p>}
  </div>;
}
