import { inspectReport } from "./reports";
import { z } from "zod";
import { deleteAccount, deleteTurn, replayDeletions, revokeAccess } from "./capture";
import { ApiError, DAY, Env, hash, json, privateHash } from "./env";
import { recover, recordConflict } from "./ledger";
import { maintain } from "./maintenance";
import { exportTurn } from "./export";
import { sendInvitation } from "./invitation-email";
import { pilotStats } from "./stats";
import { billingSync, comp, uncomp } from "./subscriptions";

export async function admin(request: Request, env: Env, input: unknown): Promise<Response> {
  if (!env.ADMIN_TOKEN) throw new ApiError(503, "admin_disabled", "Operator access is not configured.");
  const supplied = request.headers.get("Authorization") ?? "";
  const [actual, expected] = await Promise.all([
    privateHash(env.ADMIN_TOKEN, supplied), privateHash(env.ADMIN_TOKEN, `Bearer ${env.ADMIN_TOKEN}`),
  ]);
  let difference = 0;
  for (let i = 0; i < actual.length; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  if (difference) throw new ApiError(401, "unauthorized", "Operator authentication failed.");
  const data = z.discriminatedUnion("action", [
    z.object({ action: z.literal("invite"), email: z.email().transform((s) => s.toLowerCase()) }),
    z.object({ action: z.literal("usage") }),
    z.object({ action: z.literal("stats"), days: z.number().int().min(1).max(90).optional() }),
    z.object({ action: z.literal("report"), report_id: z.uuid() }),
    z.object({ action: z.literal("report_notifications") }),
    z.object({ action: z.literal("revoke"), member_id: z.string().max(100) }),
    z.object({ action: z.literal("delete_account"), member_id: z.string().max(100) }),
    z.object({ action: z.literal("delete_turn"), member_id: z.string().max(100), turn_id: z.uuid() }),
    z.object({ action: z.literal("resolve"), request_id: z.uuid(), cost_micro_usd: z.number().int().min(0).max(50_000_000), reason: z.string().min(5).max(500) }),
    z.object({ action: z.literal("resolve_without_id"), cost_micro_usd: z.number().int().min(0).max(50_000_000), reason: z.string().min(5).max(500) }),
    z.object({ action: z.literal("conflict"), conflict_id: z.number().int().positive(), resolution: z.enum(["booked", "dismissed"]), reason: z.string().min(5).max(500) }),
    z.object({ action: z.literal("pause"), paused: z.boolean() }),
    z.object({ action: z.literal("set_budget"), allowance_micro_usd: z.number().int().positive() }),
    z.object({ action: z.literal("set_capacity"), max_in_flight: z.number().int().min(1) }),
    z.object({ action: z.literal("recover"), member_id: z.string().min(1).max(100).optional(),
      spent_micro_usd: z.number().int().min(0).max(50_000_000), reason: z.string().min(5).max(500) }),
    z.object({ action: z.literal("export"), member_id: z.string().max(100), turn_id: z.uuid() }),
    z.object({ action: z.literal("comp"), email: z.email().transform((s) => s.toLowerCase()) }),
    z.object({ action: z.literal("uncomp"), member_id: z.string().max(100) }),
    z.object({ action: z.literal("billing_sync"), member_id: z.string().max(100) }),
    z.object({ action: z.literal("sweep") }),
    z.object({ action: z.literal("replay_deletions"), cursor: z.string().max(2000).optional() }),
  ]).parse(input);
  const now = Date.now();
  if (data.action === "invite") {
    if (env.BILLING_ENABLED === "true") throw new ApiError(409, "invites_retired", "Invitations have ended. Use comp for free access.");
    const code = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const codeHash = await hash(code);
    await env.DB.prepare("INSERT INTO invites(code_hash, email, expires_at) VALUES (?, ?, ?)")
      .bind(codeHash, data.email, now + 7 * DAY).run();
    try { await sendInvitation(env, data.email, code); }
    catch {
      await env.DB.prepare("DELETE FROM invites WHERE code_hash = ? AND redeemed_by IS NULL").bind(codeHash).run();
      throw new ApiError(502, "invite_email_failed", "Invitation email could not be confirmed. Run the invite command again to send a new code.");
    }
    return json({ code, expires_at: now + 7 * DAY, email_status: "accepted" });
  }
  if (data.action === "usage") {
    const [budget, members, pending, conflicts] = await Promise.all([
      env.DB.prepare("SELECT * FROM budget").first(),
      env.DB.prepare("SELECT id, spent, reserved, allowance, period_end, revoked, recovery_required FROM members ORDER BY recovery_required DESC, created_at DESC LIMIT 100").all(),
      env.DB.prepare("SELECT id, member_id, generation_id, reserved, cost, provisional, error_code, reconcile_after, updated_at FROM requests WHERE provisional = 1 OR status = 'unknown' ORDER BY updated_at LIMIT 100").all(),
      env.DB.prepare("SELECT * FROM cost_conflicts WHERE resolved_at IS NULL ORDER BY created_at LIMIT 100").all(),
    ]);
    return json({ budget, members: members.results, pending: pending.results, conflicts: conflicts.results });
  }
  if (data.action === "stats") return json(await pilotStats(env, data.days ?? 28));
  if (data.action === "billing_sync") return json(await billingSync(env, data.member_id));
  if (data.action === "comp") {
    const granted = await comp(env, data.email, now);
    await env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) VALUES ('comp', ?, ?, '')")
      .bind(granted.member_id, now).run();
    return json(granted);
  }
  if (data.action === "report") return json(await inspectReport(env, data.report_id));
  if (data.action === "report_notifications") return json((await env.DB.prepare(`SELECT id, created_at, mail_state, mail_error
    FROM support_reports WHERE state = 'ready' AND mail_state IN ('pending', 'sending', 'attention') ORDER BY created_at LIMIT 100`).all()).results);
  if (data.action === "export") return exportTurn(env, data.member_id, data.turn_id);
  if (data.action === "replay_deletions") return json({ cursor: await replayDeletions(env, data.cursor) });
  if (data.action === "set_budget" || data.action === "set_capacity") {
    const [column, value] = data.action === "set_budget" ? ["allowance", data.allowance_micro_usd] : ["max_in_flight", data.max_in_flight];
    await env.DB.batch([
      env.DB.prepare(`UPDATE budget SET ${column} = ? WHERE id = 1`).bind(value),
      env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) VALUES (?, 'service', ?, ?)")
        .bind(data.action, now, String(value)),
    ]);
    return json({ ok: true });
  }
  if (data.action === "recover") {
    await recover(env, data.member_id, data.spent_micro_usd, data.reason);
    return json({ ok: true });
  }
  const target = "member_id" in data ? data.member_id : "request_id" in data ? data.request_id : "service";
  if (data.action === "revoke") await revokeAccess(env, data.member_id);
  if (data.action === "uncomp") await uncomp(env, data.member_id, now);
  if (data.action === "delete_account") await deleteAccount(env, data.member_id);
  if (data.action === "delete_turn") await deleteTurn(env, data.member_id, data.turn_id);
  if (data.action === "resolve") {
    const read = () => env.DB.prepare("SELECT status, provisional, cost, reserved FROM requests WHERE id = ?").bind(data.request_id)
      .first<{ status: string; provisional: number; cost: number; reserved: number }>();
    const notFound = () => new ApiError(404, "not_found", "No such request.");
    // A final row is never changed: the same cost is a repeat, a different one is a dispute.
    const finalOutcome = async (row: { cost: number } | null) => {
      if (!row) throw notFound();
      if (row.cost === data.cost_micro_usd) return json({ outcome: "already_final" });
      if (!await recordConflict(env, data.request_id, "operator", row.cost, data.cost_micro_usd)) throw notFound();
      return json({ outcome: "conflict" });
    };
    const row = await read();
    if (!row) throw notFound();
    if (row.status !== "settled") throw new ApiError(409, "request_not_provisional", "Only a provisional cost can be resolved.");
    if (row.provisional !== 1) return finalOutcome(row);
    const [update] = await env.DB.batch([
      env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 0, cost = ?, updated_at = ?, error_code = 'operator_resolved'
        WHERE id = ? AND provisional = 1`).bind(data.cost_micro_usd, now, data.request_id),
      // changes() counts only the update's own rows, so the audit row exists only when it applied.
      env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) SELECT 'resolve', ?, ?, ? WHERE changes() > 0")
        .bind(data.request_id, now, data.reason),
    ]);
    // finalize_provisional pauses the service when the cost exceeds the reservation.
    if (update.meta.changes) return json(data.cost_micro_usd > row.reserved ? { outcome: "applied", paused: true } : { outcome: "applied" });
    // Someone else finalized the row between the read and the batch, and pruning may have deleted it since.
    return finalOutcome(await read());
  }
  if (data.action === "resolve_without_id") {
    // A cost within the reservation never pauses the service.
    const unresolved = "status = 'settled' AND provisional = 1 AND generation_id IS NULL AND reserved >= ?";
    // In one transaction the audit insert matches exactly the rows the update then changes.
    const [, update] = await env.DB.batch([
      env.DB.prepare(`INSERT INTO operator_actions(action, target, created_at, detail) SELECT 'resolve', id, ?, ? FROM requests WHERE ${unresolved}`)
        .bind(now, data.reason, data.cost_micro_usd),
      env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 0, cost = ?, updated_at = ?, error_code = 'operator_resolved'
        WHERE ${unresolved} RETURNING id`).bind(data.cost_micro_usd, now, data.cost_micro_usd),
    ]);
    return json({ outcome: "applied", resolved: update.results.length });
  }
  if (data.action === "conflict") {
    const [update] = await env.DB.batch([
      env.DB.prepare("UPDATE cost_conflicts SET resolved_at = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL")
        .bind(now, data.resolution, data.conflict_id),
      env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) SELECT 'conflict', ?, ?, ? WHERE changes() > 0")
        .bind(String(data.conflict_id), now, `${data.resolution}: ${data.reason}`),
    ]);
    if (update.meta.changes) return json({ outcome: "applied" });
    const exists = await env.DB.prepare("SELECT 1 FROM cost_conflicts WHERE id = ?").bind(data.conflict_id).first();
    if (!exists) throw new ApiError(404, "conflict_not_found", "No such conflict.");
    return json({ outcome: "already_resolved" });
  }
  if (data.action === "pause") {
    try { await env.DB.prepare("UPDATE budget SET paused = ?").bind(Number(data.paused)).run(); }
    catch (error) {
      if (String(error).includes("recovery_required")) throw new ApiError(409, "recovery_required", "Recover account and global spending before resuming access.");
      if (String(error).includes("cost_conflict_open")) throw new ApiError(409, "cost_conflict_open", "Resolve the open cost conflict before resuming access.");
      throw error;
    }
  }
  if (data.action === "sweep") await maintain(env);
  await env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) VALUES (?, ?, ?, ?)")
    .bind(data.action, target, now, "").run();
  return json({ ok: true });
}
