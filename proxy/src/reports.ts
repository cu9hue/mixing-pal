import { z } from "zod";
import { ApiError, DAY, Env, privateHash } from "./env";

export const MAX_REPORT_BODY = 320 * 1024;
const boundedText = z.string().max(16000);
const step = z.object({
  kind: z.enum(["model", "tool"]), at: z.number().nonnegative(), duration_ms: z.number().nonnegative(),
  turn_id: z.string().max(100), request_id: z.string().max(100).nullable(), round: z.number().int().nullable(),
  tool_call_id: z.string().max(200).nullable(),
  name: z.string().max(200).optional(), args: z.unknown().optional(), result: z.unknown().optional(), outcome: z.unknown().optional(),
}).strict();
const diagnosticsSchema = z.object({ format: z.literal("mixing-pal-incident-v1"),
  exchange: z.object({ question: boundedText, answer: boundedText.nullable(), error: boundedText.nullable() }).strict().optional(),
  connection: z.object({ connected: z.boolean(), wire_version: z.number().int().nonnegative().nullable() }).strict().optional(),
  steps: z.array(step).max(200), limitations: z.array(z.string().max(500)).max(20),
}).strict();
const reportSchema = z.object({ id: z.uuid(), origin: z.enum(["answer", "error", "settings"]), turn_id: z.uuid().optional(),
  description: z.string().trim().min(1).max(4000), app_version: z.string().max(50), wire_version: z.number().int().nonnegative().nullable(),
  diagnostics_consent: z.literal("support-2026-10-03").nullable(), diagnostics: diagnosticsSchema.optional(),
}).strict().refine(d => Boolean(d.diagnostics) === Boolean(d.diagnostics_consent))
  .refine(d => d.origin !== "settings" || (!d.turn_id && !d.diagnostics?.exchange && !d.diagnostics?.steps.length));

export interface SupportReport {
  id: string; user_id: string; turn_id: string | null; body_hash: string | null; object_key: string; bytes: number;
  state: "writing" | "ready" | "deleting" | "deleted"; created_at: number; accepted_at: number | null; updated_at: number; write_until: number;
  mail_from: string | null; reply_to: string | null; staging: number;
  mail_state: string; first_attempt_at: number | null; lease_until: number; next_attempt_at: number;
}
export async function ownedReport(env: Env, userId: string, id: string): Promise<SupportReport> {
  const row = await env.DB.prepare("SELECT * FROM support_reports WHERE id = ? AND user_id = ?")
    .bind(id, userId).first<SupportReport>();
  if (!row) throw new ApiError(404, "report_not_found", "This report was not found.");
  return row;
}
function available(row: SupportReport) {
  if (["deleting", "deleted"].includes(row.state) || (row.accepted_at ?? row.created_at) <= Date.now() - 30 * DAY) {
    throw new ApiError(410, "report_deleted", "This report has expired or was deleted.");
  }
}
export async function reportReceipt(env: Env, userId: string, id: string) {
  const row = await ownedReport(env, userId, id);
  available(row);
  if (row.state !== "ready") throw new ApiError(409, "report_pending", "This report is still being saved.");
  return { id, status: "received" as const };
}

export async function submitReport(env: Env, userId: string, input: unknown) {
  const data = reportSchema.parse(input);
  if (data.diagnostics && new TextEncoder().encode(JSON.stringify(data.diagnostics)).length > 256 * 1024) {
    throw new ApiError(413, "report_too_large", "The diagnostics are too large.");
  }
  const bodyHash = await privateHash(env.AUTH_SECRET, JSON.stringify(data));
  let row = await env.DB.prepare("SELECT * FROM support_reports WHERE id = ?").bind(data.id).first<SupportReport>();
  let created = false;
  if (!row) {
    const user = await env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>();
    if (!user) throw new ApiError(401, "sign_in_required", "Sign in to report a problem.");
    const turn = data.turn_id ? await env.DB.prepare("SELECT member_id, deleted_at FROM turns WHERE id = ?")
      .bind(data.turn_id).first<{ member_id: string; deleted_at: number | null }>() : null;
    if (turn && turn.member_id !== userId) throw new ApiError(404, "report_not_found", "This turn was not found.");
    if (turn?.deleted_at != null) throw new ApiError(410, "report_deleted", "This turn was deleted.");
    const now = Date.now();
    const staging = env.API_ORIGIN !== "https://api.mixingpal.com";
    const bytes = new TextEncoder().encode(JSON.stringify({ report: data, mail_from: env.MAIL_FROM, reply_to: user.email, staging })).length;
    try {
      const inserted = await env.DB.prepare(`INSERT INTO support_reports(id, user_id, turn_id, body_hash, object_key, bytes,
        state, created_at, updated_at, mail_from, reply_to, staging) VALUES (?, ?, ?, ?, ?, ?, 'writing', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`).bind(data.id, userId, data.turn_id ?? null, bodyHash, `reports/${userId}/${data.id}.json`,
        bytes, now, now, env.MAIL_FROM, user.email, Number(staging)).run();
      created = Boolean(inserted.meta.changes);
    } catch (error) {
      const message = String(error);
      if (message.includes("report_rate_limit")) throw new ApiError(429, "report_rate_limit", "You can send five reports per day. We will retry later.");
      if (message.includes("report_storage_limit")) throw new ApiError(503, "report_storage_limit", "Report storage is temporarily full. Please try later.");
      if (message.includes("report_account_deleted")) throw new ApiError(401, "sign_in_required", "Your account is no longer available.");
      if (message.includes("report_turn_unavailable")) throw new ApiError(410, "report_deleted", "This turn is no longer available.");
      throw error;
    }
    row = await ownedReport(env, userId, data.id);
  }
  if (row.user_id !== userId) throw new ApiError(404, "report_not_found", "This report was not found.");
  available(row);
  if (row.body_hash !== bodyHash) throw new ApiError(409, "report_conflict", "This report reference already has different content.");
  if (row.state === "ready") return { id: row.id, status: "received" as const, created: false };
  const now = Date.now();
  const lease = now + 30_000;
  const claimed = await env.DB.prepare(`UPDATE support_reports SET write_until = ?, updated_at = ?
    WHERE id = ? AND state = 'writing' AND write_until <= ?`).bind(lease, now, row.id, now).run();
  if (!claimed.meta.changes) throw new ApiError(409, "report_pending", "This report is still being saved.");
  try {
    await env.CAPTURE.put(row.object_key, JSON.stringify({ report: data, mail_from: row.mail_from,
      reply_to: row.reply_to, staging: Boolean(row.staging) }), { httpMetadata: { contentType: "application/json" } });
    const saved = await env.DB.prepare(`UPDATE support_reports SET state = 'ready', accepted_at = ?, updated_at = ? WHERE id = ? AND state = 'writing'
      AND write_until = ? AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = user_id)
      AND NOT EXISTS (SELECT 1 FROM turns WHERE id = support_reports.turn_id AND deleted_at IS NOT NULL)`)
      .bind(Date.now(), Date.now(), row.id, lease).run();
    if (!saved.meta.changes) {
      const current = await ownedReport(env, userId, row.id);
      if (["deleted", "deleting"].includes(current.state)) await env.CAPTURE.delete(row.object_key);
      throw new ApiError(409, "report_pending", "The report changed while being saved. Please retry.");
    }
  } catch (error) {
    await env.DB.prepare("UPDATE support_reports SET write_until = 0 WHERE id = ? AND state = 'writing' AND write_until = ?")
      .bind(row.id, lease).run();
    throw error;
  }
  return { id: row.id, status: "received" as const, created };
}

export async function deleteReport(env: Env, userId: string, id: string, journal = true): Promise<void> {
  const existing = await env.DB.prepare("SELECT user_id, state FROM support_reports WHERE id = ?").bind(id).first<{ user_id: string; state: string }>();
  if (existing && existing.user_id !== userId) throw new ApiError(404, "report_not_found", "This report was not found.");
  const now = Date.now();
  if (journal && (!existing || !["deleted", "deleting"].includes(existing.state))) await env.CAPTURE.put(`deletions/${now}-${crypto.randomUUID()}.json`,
    JSON.stringify({ member_id: userId, report_id: id, requested_at: now }));
  await env.DB.prepare(`INSERT INTO support_reports(id, user_id, object_key, state, created_at, updated_at, mail_state)
    VALUES (?, ?, ?, 'deleted', ?, ?, 'cancelled') ON CONFLICT(id) DO UPDATE SET state = CASE WHEN state = 'deleted' THEN 'deleted' ELSE 'deleting' END,
    mail_state = 'cancelled', updated_at = excluded.updated_at WHERE user_id = excluded.user_id`)
    .bind(id, userId, `reports/${userId}/${id}.json`, now, now).run();
}

export async function deleteReportsFor(env: Env, userId: string, turnId?: string): Promise<void> {
  await env.DB.prepare(`UPDATE support_reports SET state = CASE WHEN state = 'deleted' THEN 'deleted' ELSE 'deleting' END,
    mail_state = 'cancelled', updated_at = ? WHERE user_id = ?${turnId ? " AND turn_id = ?" : ""}`)
    .bind(Date.now(), userId, ...(turnId ? [turnId] : [])).run();
}

export async function maintainReports(env: Env): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(`UPDATE support_reports SET state = 'deleting', mail_state = 'cancelled', updated_at = ?
    WHERE state IN ('ready', 'writing') AND (COALESCE(accepted_at, created_at) <= ? OR EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = user_id))`).bind(now, now - 30 * DAY).run();
  const rows = await env.DB.prepare(`SELECT * FROM support_reports WHERE state = 'deleting'
    OR (state = 'deleted' AND updated_at < ?) ORDER BY updated_at LIMIT 100`).bind(now - DAY).all<SupportReport>();
  for (const row of rows.results) {
    try {
      await env.CAPTURE.delete(row.object_key);
      await env.DB.prepare(`UPDATE support_reports SET state = 'deleted', updated_at = ?, mail_from = NULL, reply_to = NULL,
        email_id = NULL, mail_error = NULL WHERE id = ? AND state IN ('deleting', 'deleted')`).bind(now, row.id).run();
    } catch { console.error(JSON.stringify({ event: "report_deletion_failed", report_id: row.id })); }
  }
  await env.DB.prepare("DELETE FROM support_reports WHERE state = 'deleted' AND created_at <= ? AND updated_at >= ?")
    .bind(now - 90 * DAY, now - DAY).run();
}

export async function inspectReport(env: Env, id: string) {
  const row = await env.DB.prepare("SELECT * FROM support_reports WHERE id = ?").bind(id).first<SupportReport>();
  if (!row) throw new ApiError(404, "report_not_found", "This report was not found.");
  available(row);
  if (row.state !== "ready") throw new ApiError(409, "report_pending", "This report is still being saved.");
  const object = await env.CAPTURE.get(row.object_key);
  if (!object) throw new ApiError(410, "report_deleted", "The report content is unavailable.");
  const stored = await object.json<{ report: z.infer<typeof reportSchema>; mail_from: string; reply_to: string; staging: boolean }>();
  const current = await ownedReport(env, row.user_id, id);
  available(current);
  if (await env.DB.prepare("SELECT 1 FROM deletion_jobs WHERE member_id = ?").bind(row.user_id).first()) {
    throw new ApiError(410, "report_deleted", "This account was deleted.");
  }
  return { ...stored, expires_at: (row.accepted_at ?? row.created_at) + 30 * DAY, training_allowed: false };
}
