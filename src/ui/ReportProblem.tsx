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
  const done = useRef<HTMLButtonElement>(null);
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
  useEffect(() => { if (receipt) done.current?.focus(); }, [receipt]);
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
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary")).filter((element) => element.getClientRects().length > 0);
      if (!controls.length) return;
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    }}>
    <h2 id={`${id}-title`} className="report__title">{receipt ? receipt.status === "received" ? "Report sent" : "Report saved" : "Report a problem"}</h2>
    {receipt ? <>
      <div className="report__body" role="status">
        <p>{receipt.status === "received" ? `Thank you. We can reply to ${email}.` : reportStatus[receipt.status]}</p>
        <p className="report__hint">Check its status or delete it in Settings → Support → Recent reports.</p>
        <ReportReference id={receipt.id} />
      </div>
      <div className="report__actions"><button ref={done} className="advanced__button" onClick={onClose}>Done</button></div>
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
        <textarea ref={descriptionInput} id={`${id}-description`} className="advanced__input" rows={3}
          required maxLength={4000} value={description} disabled={busy || Boolean(attempt.current)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setDescription(event.target.value)} />
        <label className="report__consent"><input type="checkbox" checked={includeDiagnostics}
          aria-describedby={`${id}-scope`} disabled={busy || Boolean(attempt.current)} onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
          Include diagnostics for this report</label>
        <p id={`${id}-scope`} className="report__hint">{target.origin === "settings"
          ? "App and Wire versions and connection status. No conversation is included."
          : "Includes this question, answer and technical details, possibly track names and MIDI."}
          {" "}For this report only; kept up to 30 days. No model training or ongoing sharing.</p>
        <p className="report__hint">Replies go to {email}.</p>
        <details className="report__details">
          <summary>What else is included?</summary>
          <p className="report__hint">Reports always include app version and screen details. Your message goes to hello@mixingpal.com. Deleting a report does not remove support emails.</p>
        </details>
        {includeDiagnostics && limitations.length > 0 && <p className="report__hint">Some technical details are unavailable. You can still send your report.</p>}
      </div>
      <div className="report__footer">
        {error && <p className="report__error" id={`${id}-error`} role="alert">{error} Retry sends the same report. Close to start a different one.</p>}
        <div className="report__actions">
          <button className="advanced__button advanced__button--primary" type="submit" disabled={busy || operations.install || !description.trim()}>{busy ? "Sending…" : error ? "Retry" : "Send report"}</button>
          <button className="advanced__button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </form>}
  </dialog>;
}

function ReportReference({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <>
    <button type="button" className="report-link" onClick={async () => {
      try { await navigator.clipboard.writeText(id); setCopied(true); setFailed(false); }
      catch { setCopied(false); setFailed(true); }
    }}>{copied ? "Copied" : "Copy reference"}</button>
    {failed && <p className="report__hint" role="status">Copy this reference: <span className="selectable">{id}</span></p>}
  </>;
}

const reportOrigins = { answer: "Answer", error: "Failed question", settings: "App problem" };

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
    <button className="report-link report-history__toggle" aria-expanded={open} aria-controls={id} onClick={() => {
      setOpen(!open); if (!open) void refresh();
    }}><span aria-hidden="true">{open ? "⌄" : "›"}</span> Recent reports</button>
    {open && <div id={id}>
      <button className="report-link" disabled={loading || busy} onClick={() => void refresh()}>Refresh status</button>
      {loading && <p role="status">Reading reports…</p>}
      {!loading && !error && !receipts.length && <p>No recent reports.</p>}
      {error && <p role="alert">{error}</p>}
      {receipts.map((receipt) => {
        const received = receipt.status === "received";
        const actionable = ["received", "queued", "needs_sign_in", "failed", "expired"].includes(receipt.status);
        return <div className="report-history__entry" key={receipt.id} tabIndex={-1} role="group" aria-label={reportOrigins[receipt.origin]}>
          <p className="report-history__origin">{reportOrigins[receipt.origin]}</p>
          <time className="report__hint" dateTime={new Date(receipt.created_at).toISOString()}>{new Date(receipt.created_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
          <p>{reportStatus[receipt.status]}</p>
          <ReportReference id={receipt.id} />
          {actionable && confirm !== receipt.id && <button className="report-link" disabled={busy || operations.install} onClick={() => setConfirm(receipt.id)}>{received ? "Delete report" : "Cancel report"}</button>}
          {confirm === receipt.id && <div>
            <p>Remove stored data and stop unsent notifications? Emails already sent cannot be recalled.</p>
            <button className="advanced__button" autoFocus disabled={busy || operations.install} onClick={async (event) => {
              const entry = event.currentTarget.closest<HTMLElement>(".report-history__entry");
              if (!beginMutation(operations, "accountMutation")) return;
              setBusy(true); setError(undefined);
              try { await deleteReport(receipt.id); setConfirm(undefined); await refresh(); entry?.focus(); }
              catch (failure) { setError(errorMessage(failure)); }
              finally { setBusy(false); operations.accountMutation = false; }
            }}>{received ? "Confirm deletion" : "Confirm cancellation"}</button>{" "}
            <button className="report-link" disabled={busy} onClick={(event) => { event.currentTarget.closest<HTMLElement>(".report-history__entry")?.focus(); setConfirm(undefined); }}>Keep report</button>
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
