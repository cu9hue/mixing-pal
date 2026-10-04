import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { beginMutation, useBusyState } from "../model/updates";
import { OUTCOME_TEXT_MAX_CHARS, Outcome, RatedExchange, Rating, clear, latestFor, rate, setHeard } from "../notes/outcomes";
import "./OutcomeRow.css";

const LABELS: Record<Rating, string> = { kept: "Kept it", undone: "Undid it" };

export function OutcomeRow({ exchange, outcomes, sharingEnabled, sentCount, onChange }: {
  exchange: RatedExchange;
  outcomes: Outcome[];
  sharingEnabled: boolean;
  sentCount: number;
  onChange: (next: Outcome[]) => boolean;
}) {
  const operations = useBusyState();
  const latest = latestFor(outcomes, exchange.turnId);
  const [hearing, setHearing] = useState(false);
  const [draft, setDraft] = useState("");
  const [shareFailed, setShareFailed] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  // Shares go out in order: a heard text saved while the rating's share is
  // still in flight would otherwise find the mutation slot taken.
  const sharing = useRef<Promise<void> | null>(null);

  useEffect(() => { setHearing(false); }, [sentCount]);

  function share(outcome: Rating, heard: string) {
    if (!sharingEnabled) return;
    // The first share claims the slot now, so a restart cannot slip in first.
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
      if (onChange(clear(outcomes, exchange.turnId))) setHearing(false);
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
    setHearing(false);
    const text = draft.trim();
    if (latest === null || text === latest.heard) return;
    if (onChange(setHeard(outcomes, exchange.turnId, text))) share(latest.outcome, text);
  }

  return <div className="outcome" data-tauri-drag-region="false">
    <div className="outcome__choices">
      {(["kept", "undone"] as const).map((o, i) => <span key={o}>
        {i > 0 && <span aria-hidden="true"> · </span>}
        <button type="button" className="outcome__link" aria-pressed={latest?.outcome === o}
          disabled={operations.install} onClick={() => choose(o)}>{LABELS[o]}</button>
      </span>)}
      {!hearing && latest !== null && latest.heard !== "" && <>
        <span aria-hidden="true"> · </span>
        <button type="button" className="outcome__link" onClick={() => { setDraft(latest.heard); setHearing(true); }}>
          {`“${latest.heard}”`}
        </button>
      </>}
    </div>
    {hearing && <input ref={field} className="outcome__heard" aria-label="What did you hear?" placeholder="What did you hear?"
      maxLength={OUTCOME_TEXT_MAX_CHARS} value={draft} onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); saveHeard(); }
        else if (e.key === "Escape") setHearing(false);
      }}
      onBlur={() => setHearing(false)} />}
    {shareFailed && <p className="outcome__status" role="status">Couldn't share this outcome.</p>}
  </div>;
}
