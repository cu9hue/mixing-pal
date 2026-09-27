import { useBusyState, beginMutation } from "../model/updates";
import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../model/account";
import { Feedback } from "./thread";

export function FeedbackPanel({ turnId, answered, saved, sharingEnabled, sentCount, onSave }: { turnId: string; answered: boolean; saved?: Feedback; sharingEnabled: boolean; sentCount: number; onSave: (value: Feedback) => void }) {
  const operations = useBusyState();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Feedback["outcome"]>(saved?.outcome ?? "not_tried");
  const [heard, setHeard] = useState(saved?.heard ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { setOpen(false); setDeleting(false); }, [sentCount]);

  return <div className="feedback" data-tauri-drag-region="false">
    <button aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{answered ? saved ? "Your outcome" : "Tried this advice?" : "Shared turn"}</button>
    {open && <form id={id} onSubmit={async (e) => {
      e.preventDefault();
      if (!answered || !beginMutation(operations, "accountMutation")) return;
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
      } catch (error) { setMessage(`Saved on this laptop. Could not share: ${errorMessage(error)}`); }
      finally { setBusy(false); operations.accountMutation = false; }
    }}>
      {answered && <><label htmlFor={`${id}-outcome`}>What did you do?</label>{" "}
      <select id={`${id}-outcome`} value={outcome} disabled={busy || operations.install} onChange={(e) => setOutcome(e.target.value as Feedback["outcome"])}>
        <option value="not_tried">Haven't tried it</option><option value="tried">Tried it, still deciding</option>
        <option value="kept">Tried it and kept it</option><option value="undone">Tried it and undid it</option>
      </select>
      <label htmlFor={`${id}-heard`}>What did you hear?</label>
      <textarea id={`${id}-heard`} value={heard} maxLength={4000} rows={2} disabled={busy || operations.install} onChange={(e) => setHeard(e.target.value)} />
      </>}
      <div className="account__actions">{answered && <button type="submit" disabled={busy || operations.install}>Save outcome</button>}
        <button type="button" disabled={busy || operations.install} onClick={() => setDeleting(true)}>Delete shared turn…</button></div>
      {deleting && <div><p>Delete this turn's shared questions, answers, tool reads and feedback?</p>
        <button type="button" disabled={busy || operations.install} onClick={async () => {
          if (!beginMutation(operations, "accountMutation")) return;
          setBusy(true);
          try { await invoke("turn_delete_capture", { turnId }); setMessage("Deletion requested. Your local conversation stays here."); setDeleting(false); }
          catch (error) { setMessage(errorMessage(error)); }
          finally { setBusy(false); operations.accountMutation = false; }
        }}>Delete shared turn</button>{" "}
        <button type="button" disabled={busy || operations.install} onClick={() => setDeleting(false)}>Cancel</button>
      </div>}
      {message && <p role="status">{message}</p>}
    </form>}
  </div>;
}
