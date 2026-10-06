import { retryReportMail } from "./report-email";
import { maintainReports } from "./reports";
import { deleteTurn } from "./capture";
import { DAY, Env, readJson } from "./env";
import { settle, settleExpired } from "./ledger";

const CAPTURE_DELETE_BATCH = 100;
const CAPTURE_DELETE_BATCHES = 3;

/** OpenRouter marks a finished generation with a finish reason or a cancel; elapsed time is never proof. */
export function generationComplete(data: Record<string, unknown>): boolean {
  return (typeof data.finish_reason === "string" && data.finish_reason.length > 0) || data.cancelled === true;
}

async function billing(env: Env, now: number): Promise<void> {
  await settleExpired(env, now);
  const pending = await env.DB.prepare(`SELECT id, generation_id FROM requests WHERE provisional = 1 AND generation_id IS NOT NULL
    AND reconcile_after <= ? ORDER BY reconcile_after LIMIT 20`).bind(now).all<{ id: string; generation_id: string }>();
  const stopAt = Date.now() + 30_000;
  for (const row of pending.results) {
    if (Date.now() > stopAt) break;
    await env.DB.prepare("UPDATE requests SET reconcile_after = ? WHERE id = ?").bind(now + 10 * 60_000, row.id).run();
    try {
      const response = await fetch(`https://openrouter.ai/api/v1/generation?id=${encodeURIComponent(row.generation_id)}`, {
        headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}` }, signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) { await response.body?.cancel(); continue; }
      const data = ((await readJson(response)) as { data?: Record<string, unknown> })?.data ?? {};
      const cost = data.total_cost;
      if (generationComplete(data) && typeof cost === "number" && Number.isFinite(cost) && cost >= 0) {
        await settle(env, row.id, Math.ceil(cost * 1_000_000), { errorCode: "reconciled" }, "generation");
      }
    } catch {
      console.error(JSON.stringify({ event: "reconciliation_failed", request_id: row.id }));
    }
  }
}

export async function maintain(env: Env): Promise<void> {
  const now = Date.now();
  // Billing first and on its own: a report or cleanup failure must never hold a member's money.
  try { await billing(env, now); }
  catch (error) { console.error(JSON.stringify({ event: "billing_maintenance_failed", error: String(error) })); }
  try { await maintainReports(env); await retryReportMail(env); }
  catch (error) { console.error(JSON.stringify({ event: "report_maintenance_failed", error: String(error) })); }
  await env.DB.batch([
    env.DB.prepare("UPDATE turns SET status = 'interrupted', incomplete = 1 WHERE status = 'running' AND updated_at < ?").bind(now - 20 * 60_000),
    env.DB.prepare('DELETE FROM verification WHERE expiresAt < ?').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM "session" WHERE expiresAt < ?').bind(new Date(now).toISOString()),
    env.DB.prepare('DELETE FROM "rateLimit" WHERE lastRequest < ?').bind(now - DAY),
    env.DB.prepare("DELETE FROM api_limits WHERE expires_at < ?").bind(now - DAY),
    env.DB.prepare("DELETE FROM invites WHERE expires_at < ?").bind(now - 83 * DAY),
    env.DB.prepare("DELETE FROM operator_actions WHERE created_at < ?").bind(now - 90 * DAY),
    env.DB.prepare(`DELETE FROM "user" WHERE createdAt < ? AND NOT EXISTS (SELECT 1 FROM members WHERE members.id = "user".id)`)
      .bind(new Date(now - 90 * DAY).toISOString()),
  ]);
  const expired = await env.DB.prepare("SELECT id, member_id FROM turns WHERE created_at <= ? AND deleted_at IS NULL LIMIT 100")
    .bind(now - 30 * DAY).all<{ id: string; member_id: string }>();
  for (const row of expired.results) await deleteTurn(env, row.member_id, row.id, true, true);
  // Keep tombstones and re-delete their object keys. A Worker canceled during
  // an R2 write can finish that write after the first deletion pass.
  const backlog = await env.DB.prepare(`SELECT COUNT(*) AS count, MIN(c.updated_at) AS oldest_updated_at
    FROM captures c JOIN turns t ON t.id = c.turn_id
    WHERE c.state = 'deleting' OR (c.state = 'writing' AND c.updated_at < ?)
    OR (c.state = 'deleted' AND c.updated_at < ?) OR (c.state != 'deleted' AND t.deleted_at IS NOT NULL)
    `).bind(now - 5 * 60_000, now - DAY).first<{ count: number; oldest_updated_at: number | null }>();
  if (backlog && backlog.count > CAPTURE_DELETE_BATCH) {
    console.error(JSON.stringify({ event: "capture_cleanup_backlog", count: backlog.count,
      oldest_updated_at: backlog.oldest_updated_at }));
  }
  for (let batch = 0; batch < CAPTURE_DELETE_BATCHES; batch++) {
    const objects = await env.DB.prepare(`SELECT c.id, c.object_key FROM captures c JOIN turns t ON t.id = c.turn_id
      WHERE c.state = 'deleting' OR (c.state = 'writing' AND c.updated_at < ?)
      OR (c.state = 'deleted' AND c.updated_at < ?) OR (c.state != 'deleted' AND t.deleted_at IS NOT NULL)
      ORDER BY c.state = 'deleted', c.updated_at LIMIT ?`).bind(now - 5 * 60_000, now - DAY, CAPTURE_DELETE_BATCH)
      .all<{ id: string; object_key: string }>();
    let failed = false;
    for (const row of objects.results) {
      try {
        await env.CAPTURE.delete(row.object_key);
        await env.DB.prepare("UPDATE captures SET state = 'deleted', updated_at = ? WHERE id = ?").bind(now, row.id).run();
      } catch {
        failed = true;
        console.error(JSON.stringify({ event: "deletion_failed", capture_id: row.id }));
      }
    }
    if (failed || objects.results.length < CAPTURE_DELETE_BATCH) break;
  }
  const deletions = await env.DB.prepare("SELECT member_id FROM deletion_jobs WHERE completed_at IS NULL AND requested_at < ? LIMIT 20")
    .bind(now - 10 * 60_000).all<{ member_id: string }>();
  for (const { member_id: id } of deletions.results) {
    const unfinished = await env.DB.prepare(`SELECT id FROM captures WHERE turn_id IN (SELECT id FROM turns WHERE member_id = ?)
      AND state != 'deleted' LIMIT 1`).bind(id).first();
    if (unfinished || await env.DB.prepare("SELECT 1 FROM support_reports WHERE user_id = ? AND state != 'deleted' LIMIT 1").bind(id).first()) continue;
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM verification WHERE identifier IN (
        SELECT 'sign-in-otp-' || lower(email) FROM "user" WHERE id = ?
        UNION SELECT 'sign-in-otp-' || email FROM "user" WHERE id = ?)` ).bind(id, id),
      env.DB.prepare('DELETE FROM invites WHERE email = (SELECT lower(email) FROM "user" WHERE id = ?)').bind(id),
      env.DB.prepare('DELETE FROM "user" WHERE id = ?').bind(id),
      env.DB.prepare("DELETE FROM consents WHERE member_id = ?").bind(id),
      env.DB.prepare("UPDATE deletion_jobs SET completed_at = ? WHERE member_id = ?").bind(now, id),
    ]);
  }
  // Balances outlive request metadata; unresolved accounting is never pruned (request_retention enforces it).
  const old = await env.DB.prepare(`SELECT t.id FROM turns t WHERE t.created_at < ?
    AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.turn_id = t.id AND (r.status != 'settled' OR r.provisional = 1))
    AND NOT EXISTS (SELECT 1 FROM cost_conflicts c JOIN requests r ON r.id = c.request_id WHERE r.turn_id = t.id AND c.resolved_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM captures c WHERE c.turn_id = t.id AND c.state != 'deleted') LIMIT 100`)
    .bind(now - 90 * DAY).all<{ id: string }>();
  for (const { id } of old.results) {
    // A conflict opened since the read makes request_retention roll this turn back; the next turn still goes.
    try {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM cost_conflicts WHERE request_id IN (SELECT id FROM requests WHERE turn_id = ?) AND resolved_at IS NOT NULL").bind(id),
        env.DB.prepare("DELETE FROM captures WHERE turn_id = ?").bind(id),
        env.DB.prepare("DELETE FROM requests WHERE turn_id = ?").bind(id),
        env.DB.prepare("DELETE FROM turns WHERE id = ?").bind(id),
      ]);
    } catch (error) {
      console.error(JSON.stringify({ event: "prune_skipped", turn_id: id, error: String(error) }));
    }
  }
  const health = await env.DB.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(cost), 0) AS amount, MIN(updated_at) AS oldest,
    SUM(generation_id IS NULL) AS without_id FROM requests WHERE provisional = 1`)
    .first<{ count: number; amount: number; oldest: number | null; without_id: number }>();
  const conflicts = await env.DB.prepare("SELECT COUNT(*) AS n FROM cost_conflicts WHERE resolved_at IS NULL").first<{ n: number }>();
  const budget = await env.DB.prepare("SELECT loss, paused FROM budget").first<{ loss: number; paused: number }>();
  if (health?.count || conflicts?.n || budget?.loss || budget?.paused) console.error(JSON.stringify({ event: "provisional_usage",
    count: health?.count ?? 0, amount: health?.amount ?? 0, oldest: health?.oldest ?? null, without_id: health?.without_id ?? 0,
    open_conflicts: conflicts?.n ?? 0, loss: budget?.loss ?? 0, paused: budget?.paused ?? 0 }));
  const journal = await env.CAPTURE.list({ prefix: "deletions/", limit: 100 });
  for (const object of journal.objects) {
    if (object.uploaded.getTime() < now - 90 * DAY) await env.CAPTURE.delete(object.key);
  }
}
