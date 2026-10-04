import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../model/account";
import { beginMutation, useBusyState } from "../model/updates";
import { deleteReport, listReports, previewReport, ReportReceipt, ReportTarget, reportStatus, sendReport } from "../model/reports";
import "./ReportProblem.css";

export function ReportProblem({ target, accountId, email, onClose }: {
  target: ReportTarget; accountId: string; email: string; onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const descriptionInput = useRef<HTMLTextAreaElement>(null);
  const operations = useBusyState();
  const [description, setDescription] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<ReportReceipt>();
  const attempt = useRef<Parameters<typeof sendReport>[0]>(undefined);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = dialog.current!;
    element.showModal(); descriptionInput.current?.focus();
    return () => { element.close(); previous?.focus(); };
  }, []);
  useEffect(() => {
    if (!includeDiagnostics) return;
    let current = true;
    previewReport(target.exchange).then((value) => { if (current) setLimitations(value.limitations); })
      .catch(() => { if (current) setLimitations(["Some technical details may be unavailable."]); });
    return () => { current = false; };
  }, [includeDiagnostics, target.exchange]);

  return <dialog ref={dialog} className="report" aria-labelledby={`${id}-title`} data-tauri-drag-region="false"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}
    onKeyDown={(event) => {
      if (event.key === "Escape") event.stopPropagation();
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled)"));
      if (!controls.length) return;
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    }}>
    <h2 id={`${id}-title`} className="report__title">Report a problem</h2>
    {receipt ? <>
      <div className="report__body" role="status">
        <p>{reportStatus[receipt.status]}</p>
        <p className="report__hint">Reference: {receipt.id}</p>
        <p>You can check or delete this report in Settings → Recent reports.</p>
      </div>
      <div className="report__actions"><button className="advanced__button" onClick={onClose} autoFocus>Done</button></div>
    </> : <form className="report__form" onSubmit={async (event) => {
      event.preventDefault();
      if (!description.trim() || !beginMutation(operations, "accountMutation")) return;
      setBusy(true); setError(undefined);
      attempt.current ??= { origin: target.origin, exchange: target.exchange, id: crypto.randomUUID(), accountId, description: description.trim(), includeDiagnostics };
      try { setReceipt(await sendReport(attempt.current)); }
      catch (failure) { setError(errorMessage(failure)); }
      finally { setBusy(false); operations.accountMutation = false; }
    }}>
      <div className="report__body">
        <label htmlFor={`${id}-description`}>What went wrong?</label>
        <textarea ref={descriptionInput} id={`${id}-description`} className="advanced__input" rows={4}
          required maxLength={4000} value={description} disabled={busy || Boolean(attempt.current)}
          aria-describedby={`${id}-destination${error ? ` ${id}-error` : ""}`}
          onChange={(event) => setDescription(event.target.value)} />
        <p id={`${id}-destination`} className="report__hint">Your message goes to hello@mixingpal.com. We can reply to {email}.</p>
        <label className="report__consent"><input type="checkbox" checked={includeDiagnostics}
          disabled={busy || Boolean(attempt.current)} onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
          Include diagnostics for this report</label>
        <p className="report__hint">{target.origin === "settings"
          ? "Share app and Wire versions and connection status. No conversation is included."
          : "Share the selected question, answer and available technical details, which may include track names and MIDI."}
          {" "}Used to investigate this report, kept for up to 30 days. This does not turn on ongoing sharing or permit model training.</p>
        {includeDiagnostics && limitations.map((line, index) => <p className="report__hint" key={index}>{line}</p>)}
        <p className="report__hint">Reports include app version and screen details. Support emails are not removed by app deletion.</p>
        {error && <p id={`${id}-error`} role="alert">{error} Retry sends the same report; close to start a different one.</p>}
      </div>
      <div className="report__actions">
        <button className="advanced__button advanced__button--primary" type="submit" disabled={busy || operations.install || !description.trim()}>{busy ? "Sending…" : "Send report"}</button>
        <button className="advanced__button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>}
  </dialog>;
}

export function ReportHistory() {
  const id = useId();
  const operations = useBusyState();
  const [open, setOpen] = useState(false);
  const [receipts, setReceipts] = useState<ReportReceipt[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState(false);
  async function refresh() {
    setLoading(true); setError(undefined);
    try { setReceipts(await listReports()); } catch (failure) { setError(errorMessage(failure)); }
    finally { setLoading(false); }
  }
  return <div className="report-history">
    <button className="advanced__button" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen(!open); if (!open) void refresh();
    }}>Recent reports</button>
    {open && <div id={id}>
      <button className="advanced__button" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</button>
      {loading && <p role="status">Reading reports…</p>}
      {!loading && !error && !receipts.length && <p>No recent reports.</p>}
      {error && <p role="alert">{error}</p>}
      {receipts.map((receipt) => {
        const received = receipt.status === "received";
        const actionable = ["received", "queued", "needs_sign_in", "failed", "expired"].includes(receipt.status);
        return <div className="report-history__entry" key={receipt.id}>
          <p>{reportStatus[receipt.status]}</p>
          <p className="report__hint">Reference: {receipt.id}</p>
          {actionable && <button className="advanced__button" disabled={busy || operations.install} onClick={() => setConfirm(receipt.id)}>{received ? "Delete report" : "Cancel report"}</button>}
          {confirm === receipt.id && <div>
            <p>Remove stored data and stop unsent notifications? Emails already sent cannot be recalled.</p>
            <button className="advanced__button" disabled={busy || operations.install} onClick={async () => {
              if (!beginMutation(operations, "accountMutation")) return;
              setBusy(true); setError(undefined);
              try { await deleteReport(receipt.id); setConfirm(undefined); await refresh(); }
              catch (failure) { setError(errorMessage(failure)); }
              finally { setBusy(false); operations.accountMutation = false; }
            }}>{received ? "Confirm deletion" : "Confirm cancellation"}</button>{" "}
            <button className="advanced__button" disabled={busy} onClick={() => setConfirm(undefined)}>Keep report</button>
          </div>}
        </div>;
      })}
    </div>}
  </div>;
}

export function SupportContact() {
  const [copied, setCopied] = useState(false);
  return <p className="report__hint">Need help? <span className="selectable" data-tauri-drag-region="false">hello@mixingpal.com</span>{" "}
    <button type="button" className="advanced__button" onClick={() => {
      void navigator.clipboard.writeText("hello@mixingpal.com").then(() => setCopied(true)).catch(() => setCopied(false));
    }}>{copied ? "Copied" : "Copy email"}</button></p>;
}
