import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorMessage } from "../model/account";
import { Feedback } from "./thread";

export function FeedbackPanel({ turnId, answered, saved, onSave }: { turnId: string; answered: boolean; saved?: Feedback; onSave: (value: Feedback) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<Feedback["outcome"]>(saved?.outcome ?? "not_tried");
  const [heard, setHeard] = useState(saved?.heard ?? "");
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [deleting, setDeleting] = useState(false);

  return <div className="feedback" data-tauri-drag-region="false">
    <button aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>{answered ? saved ? "Your outcome" : "Tried this advice?" : "Shared turn"}</button>
    {open && <form id={id} onSubmit={async (e) => {
      e.preventDefault();
      if (!answered) return;
      setBusy(true); setMessage("");
      const value = { outcome, heard, shared: false };
      onSave(value);
      try {
        if (share) {
          const result = await invoke<{ saved: boolean }>("turn_feedback", {
            turnId, feedback: { id: crypto.randomUUID(), outcome, heard, share: true },
          });
          if (!result.saved) throw new Error("This shared turn has expired or was deleted. Your feedback is saved on this laptop.");
          onSave({ ...value, shared: true });
        }
        setMessage(share ? "Saved and shared." : "Saved on this laptop.");
      } catch (error) { setMessage(errorMessage(error)); }
      finally { setBusy(false); }
    }}>
      {answered && <><label htmlFor={`${id}-outcome`}>What did you do?</label>{" "}
      <select id={`${id}-outcome`} value={outcome} disabled={busy} onChange={(e) => setOutcome(e.target.value as Feedback["outcome"])}>
        <option value="not_tried">Haven't tried it</option><option value="tried">Tried it, still deciding</option>
        <option value="kept">Tried it and kept it</option><option value="undone">Tried it and undid it</option>
      </select>
      <label htmlFor={`${id}-heard`}>What did you hear?</label>
      <textarea id={`${id}-heard`} value={heard} maxLength={4000} rows={2} disabled={busy} onChange={(e) => setHeard(e.target.value)} />
      <label htmlFor={`${id}-share`}><input id={`${id}-share`} type="checkbox" checked={share} disabled={busy}
        onChange={(e) => setShare(e.target.checked)} /> Share this report with Mixing Pal for review</label>
      <p>Optional. Shared reports are kept with this advice for up to 30 days. This does not enable conversation sharing or permit training.</p></>}
      <div className="account__actions">{answered && <button type="submit" disabled={busy}>Save outcome</button>}
        <button type="button" disabled={busy} onClick={() => setDeleting(true)}>Delete shared turn…</button></div>
      {deleting && <div><p>Delete this turn's shared questions, answers, tool reads and feedback?</p>
        <button type="button" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await invoke("turn_delete_capture", { turnId }); setMessage("Deletion requested. Your local conversation stays here."); setDeleting(false); }
          catch (error) { setMessage(errorMessage(error)); }
          finally { setBusy(false); }
        }}>Delete shared turn</button>{" "}
        <button type="button" disabled={busy} onClick={() => setDeleting(false)}>Cancel</button>
      </div>}
      {message && <p role="status">{message}</p>}
    </form>}
  </div>;
}
