import { useBusyState, beginMutation } from "../model/updates";
import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../model/account";
import { Feedback } from "./thread";

const OUTCOMES: Record<Feedback["outcome"], string> = {
  not_tried: "Haven't tried it",
  tried: "Tried it, still deciding",
  kept: "Tried it and kept it",
  undone: "Tried it and undid it",
};

export function FeedbackPanel({ turnId, saved, sharingEnabled, sentCount, onSave }: { turnId: string; saved?: Feedback; sharingEnabled: boolean; sentCount: number; onSave: (value: Feedback) => void }) {
  const operations = useBusyState();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Feedback["outcome"]>(saved?.outcome ?? "not_tried");
  const [heard, setHeard] = useState(saved?.heard ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => { setOpen(false); }, [sentCount]);

  return <div className="feedback" data-tauri-drag-region="false">
    <button type="button" className="feedback__link" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      {saved ? OUTCOMES[saved.outcome] : "Tried it?"}
    </button>
    {open && <form id={id} onSubmit={async (e) => {
      e.preventDefault();
      if (!beginMutation(operations, "accountMutation")) return;
      setBusy(true); setMessage("");
      const value = { outcome, heard, shared: false };
      onSave(value);
      try {
        if (sharingEnabled) {
          const result = await invoke<{ saved: boolean }>("turn_feedback", {
            turnId, feedback: { id: crypto.randomUUID(), outcome, heard },
          });
          if (result.saved) onSave({ ...value, shared: true });
          setMessage(result.saved ? "Saved and shared." : "Saved on this laptop. This advice was not shared.");
        } else {
          setMessage("Saved on this laptop.");
        }
        setOpen(false);
      } catch (error) { setMessage(`Saved on this laptop. Could not share: ${errorMessage(error)}`); }
      finally { setBusy(false); operations.accountMutation = false; }
    }}>
      <label htmlFor={`${id}-outcome`}>What did you do?</label>{" "}
      <select id={`${id}-outcome`} value={outcome} disabled={busy || operations.install} onChange={(e) => setOutcome(e.target.value as Feedback["outcome"])}>
        {Object.entries(OUTCOMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select>
      <label htmlFor={`${id}-heard`}>What did you hear?</label>
      <textarea id={`${id}-heard`} value={heard} maxLength={4000} rows={2} disabled={busy || operations.install} onChange={(e) => setHeard(e.target.value)} />
      <div className="account__actions"><button type="submit" disabled={busy || operations.install}>Save outcome</button></div>
    </form>}
    {message && <p className="feedback__status" role="status">{message}</p>}
  </div>;
}
