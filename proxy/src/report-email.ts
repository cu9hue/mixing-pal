import { DAY, Env, readJson } from "./env";
import { inspectReport, SupportReport } from "./reports";

export async function notifyReport(env: Env, id: string): Promise<void> {
  const now = Date.now();
  const deadline = now - 23 * 60 * 60 * 1000;
  const expired = await env.DB.prepare(`UPDATE support_reports SET mail_state = 'attention', mail_error = 'retry_deadline'
    WHERE id = ? AND state = 'ready' AND mail_state IN ('pending', 'sending') AND first_attempt_at <= ?`)
    .bind(id, deadline).run();
  if (expired.meta.changes) console.error(JSON.stringify({ event: "report_notification_attention", report_id: id }));
  const lease = now + 120_000;
  const row = await env.DB.prepare(`UPDATE support_reports SET mail_state = 'sending', lease_until = ?,
    first_attempt_at = COALESCE(first_attempt_at, ?) WHERE id = ? AND state = 'ready'
    AND COALESCE(accepted_at, created_at) > ? AND next_attempt_at <= ?
    AND (mail_state = 'pending' OR (mail_state = 'sending' AND lease_until <= ?)) RETURNING *`)
    .bind(lease, now, id, now - 30 * DAY, now, now).first<SupportReport>();
  if (!row) return;
  let state = "pending";
  let error = "mail_interrupted";
  let emailId: string | null = null;
  try {
    const stored = await inspectReport(env, id);
    const r = stored.report;
    // inspectReport rechecks deletion after the object read, before dispatch.
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${env.RESEND_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `support-report/${id}` },
      body: JSON.stringify({ from: stored.mail_from, to: ["hello@mixingpal.com"], reply_to: stored.reply_to,
        subject: `${stored.staging ? "[STAGING] " : ""}[Mixing Pal report] ${id}`,
        text: `Report: ${id}\nApp: ${r.app_version}\nWire: ${r.wire_version ?? "unknown"}\nFrom: ${r.origin}\nDiagnostics: ${r.diagnostics ? "included" : "not included"}\n\n${r.description}\n\nInspect privately: npm run admin -- report ${id}\nStored report data expires after 30 days. Email copies are not removed by app deletion.`,
      }),
    });
    const value = await readJson(response, 8192) as { id?: unknown; name?: string };
    if (response.ok && typeof value.id === "string" && value.id.length <= 200) {
      state = "accepted"; emailId = value.id; error = "";
    } else {
      error = `mail_http_${response.status}`;
      if (response.status >= 400 && response.status < 500 && response.status !== 429
        && !(response.status === 409 && value.name === "concurrent_idempotent_requests")) state = "attention";
    }
  } catch { /* The lease remains retryable if storage or the mail connection fails. */ }
  const updated = await env.DB.prepare(`UPDATE support_reports SET mail_state = ?, email_id = ?, mail_error = ?, next_attempt_at = ?, lease_until = 0
    WHERE id = ? AND state = 'ready' AND mail_state = 'sending' AND lease_until = ?`)
    .bind(state, emailId, error || null, now + 10 * 60_000, id, lease).run();
  if (updated.meta.changes && state === "attention") console.error(JSON.stringify({ event: "report_notification_attention", report_id: id }));
}

export async function retryReportMail(env: Env): Promise<void> {
  const rows = await env.DB.prepare(`SELECT id FROM support_reports WHERE state = 'ready'
    AND mail_state IN ('pending', 'sending') AND next_attempt_at <= ? ORDER BY created_at LIMIT 10`)
    .bind(Date.now()).all<{ id: string }>();
  await Promise.all(rows.results.map(row => notifyReport(env, row.id)));
}
