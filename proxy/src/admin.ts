import { inspectReport } from "./reports";
import { z } from "zod";
import { deleteAccount, deleteTurn, replayDeletions, revokeAccess } from "./capture";
import { ApiError, DAY, Env, hash, json, privateHash } from "./env";
import { recover, settle } from "./ledger";
import { maintain } from "./maintenance";
import { exportTurn } from "./export";
import { sendInvitation } from "./invitation-email";
import { pilotStats } from "./stats";

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
    z.object({ action: z.literal("pause"), paused: z.boolean() }),
    z.object({ action: z.literal("recover"), member_id: z.string().min(1).max(100).optional(),
      spent_micro_usd: z.number().int().min(0).max(50_000_000), reason: z.string().min(5).max(500) }),
    z.object({ action: z.literal("export"), member_id: z.string().max(100), turn_id: z.uuid() }),
    z.object({ action: z.literal("sweep") }),
    z.object({ action: z.literal("replay_deletions"), cursor: z.string().max(2000).optional() }),
  ]).parse(input);
  const now = Date.now();
  if (data.action === "invite") {
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
    const [budget, members, pending] = await Promise.all([
      env.DB.prepare("SELECT * FROM budget").first(),
      env.DB.prepare("SELECT id, spent, reserved, allowance, period_end, revoked, recovery_required FROM members ORDER BY recovery_required DESC, created_at DESC LIMIT 100").all(),
      env.DB.prepare("SELECT id, member_id, generation_id, reserved, updated_at FROM requests WHERE status = 'unknown' ORDER BY updated_at LIMIT 100").all(),
    ]);
    return json({ budget, members: members.results, pending: pending.results });
  }
  if (data.action === "stats") return json(await pilotStats(env, data.days ?? 28));
  if (data.action === "report") return json(await inspectReport(env, data.report_id));
  if (data.action === "report_notifications") return json((await env.DB.prepare(`SELECT id, created_at, mail_state, mail_error
    FROM support_reports WHERE state = 'ready' AND mail_state IN ('pending', 'sending', 'attention') ORDER BY created_at LIMIT 100`).all()).results);
  if (data.action === "export") return exportTurn(env, data.member_id, data.turn_id);
  if (data.action === "replay_deletions") return json({ cursor: await replayDeletions(env, data.cursor) });
  if (data.action === "recover") {
    await recover(env, data.member_id, data.spent_micro_usd, data.reason);
    return json({ ok: true });
  }
  const target = "member_id" in data ? data.member_id : "request_id" in data ? data.request_id : "service";
  if (data.action === "revoke") await revokeAccess(env, data.member_id);
  if (data.action === "delete_account") await deleteAccount(env, data.member_id);
  if (data.action === "delete_turn") await deleteTurn(env, data.member_id, data.turn_id);
  if (data.action === "resolve") {
    const request = await env.DB.prepare("SELECT status FROM requests WHERE id = ?").bind(data.request_id).first<{ status: string }>();
    if (request?.status !== "unknown") throw new ApiError(409, "request_not_unknown", "Only an unknown cost can be resolved manually.");
    await settle(env, data.request_id, data.cost_micro_usd, { errorCode: "operator_resolved" });
  }
  if (data.action === "pause") {
    try { await env.DB.prepare("UPDATE budget SET paused = ?").bind(Number(data.paused)).run(); }
    catch (error) {
      if (String(error).includes("recovery_required")) throw new ApiError(409, "recovery_required", "Recover account and global spending before resuming access.");
      throw error;
    }
  }
  if (data.action === "sweep") await maintain(env);
  await env.DB.prepare("INSERT INTO operator_actions(action, target, created_at, detail) VALUES (?, ?, ?, ?)")
    .bind(data.action, target, now, data.action === "resolve" ? data.reason : "").run();
  return json({ ok: true });
}
