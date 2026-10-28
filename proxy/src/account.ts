import { z } from "zod";
import { ApiError, CAPTURE_VERSION, DAY, Env, hash, json } from "./env";
import { settleExpired } from "./ledger";
import { RESERVATION } from "./policy";

export interface Member {
  id: string;
  revoked: number;
  period_end: number;
  allowance: number;
  spent: number;
  reserved: number;
  capture: number;
  consent_epoch: number;
  deleted_at: number | null;
  recovery_required: number;
  comp: number;
}

export async function member(env: Env, id: string): Promise<Member | null> {
  return env.DB.prepare("SELECT * FROM members WHERE id = ?").bind(id).first<Member>();
}

export async function account(env: Env, id: string, modern = false): Promise<Response> {
  // The app polls this; settling expired calls here unblocks her without waiting for cron.
  try { await settleExpired(env, Date.now()); }
  catch { console.error(JSON.stringify({ event: "account_cleanup_failed", member_id: id })); }
  const [m, user, budget, latestConsent, sub] = await Promise.all([
    member(env, id),
    env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(id).first<{ email: string }>(),
    env.DB.prepare("SELECT paused, recovery_required, allowance, spent, reserved FROM budget")
      .first<{ paused: number; recovery_required: number; allowance: number; spent: number; reserved: number }>(),
    env.DB.prepare("SELECT version, enabled FROM consents WHERE member_id = ? ORDER BY id DESC LIMIT 1")
      .bind(id).first<{ version: string; enabled: number }>(),
    env.DB.prepare("SELECT plan, status, cancel_at_period_end, trial_used FROM subscriptions WHERE member_id = ?")
      .bind(id).first<{ plan: string | null; status: string; cancel_at_period_end: number; trial_used: number }>(),
  ]);
  const budgetShort = !budget || budget.allowance - budget.spent - budget.reserved < RESERVATION;
  const servicePaused = env.INFERENCE_ENABLED !== "true" || !env.OPENROUTER_KEY || !budget || budgetShort
    || Boolean(budget.paused || budget.recovery_required || m?.recovery_required);
  const billing = env.BILLING_ENABLED === "true";
  // Older apps know only expired; they cannot show plans.
  const ended = billing && modern ? "plan_required" : "expired";
  return json({ id, email: user?.email ?? "", access: !m ? (billing ? ended : "invitation_required")
    : m.revoked || m.deleted_at ? "revoked" : m.period_end <= Date.now() ? ended : "active",
    remaining_micro_usd: m ? Math.max(0, m.allowance - m.spent - m.reserved) : 0,
    allowance_micro_usd: m?.allowance ?? 0,
    can_ask: Boolean(!servicePaused && m && !m.revoked && !m.deleted_at && m.period_end > Date.now()
      && m.allowance - m.spent - m.reserved >= RESERVATION),
    service_paused: servicePaused,
    reserved_micro_usd: m?.reserved ?? 0, period_end: m?.period_end ?? null,
    capture: m?.capture === 1 && latestConsent?.version === CAPTURE_VERSION && latestConsent.enabled === 1,
    sharing_chosen: latestConsent?.version === CAPTURE_VERSION,
    consent_epoch: m?.consent_epoch ?? 0,
    plan: sub?.plan ?? null, subscription_status: sub && sub.status !== "none" ? sub.status : null,
    cancel_at_period_end: sub?.cancel_at_period_end === 1, comp: m?.comp === 1,
    trial_available: !m && sub?.trial_used !== 1, manage: Boolean(sub && sub.status !== "none"),
    consent_version: CAPTURE_VERSION, training: false });
}

export async function redeem(env: Env, id: string, input: unknown, modern = false): Promise<Response> {
  if (env.BILLING_ENABLED === "true") throw new ApiError(410, "invites_retired", "Invitations have ended. Choose a plan to continue.");
  const { code } = z.object({ code: z.string().trim().min(20).max(128) }).parse(input);
  const codeHash = await hash(code);
  const now = Date.now();
  // An invite must belong to the verified email of this session. Its
  // conditional UPDATE and the grant are one transaction, including retries.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE invites SET redeemed_by = ?, redeemed_at = ?
      WHERE code_hash = ? AND redeemed_by IS NULL AND expires_at > ?
      AND email = (SELECT lower(email) FROM "user" WHERE id = ? AND emailVerified = 1)
      AND NOT EXISTS (SELECT 1 FROM members WHERE id = ?)
      AND NOT EXISTS (SELECT 1 FROM deletion_jobs WHERE member_id = ?)`)
      .bind(id, now, codeHash, now, id, id, id),
    env.DB.prepare(`INSERT INTO members(id, period_end, created_at)
      SELECT redeemed_by, redeemed_at + ?, redeemed_at FROM invites
      WHERE code_hash = ? AND redeemed_by = ?
      ON CONFLICT(id) DO NOTHING`).bind(30 * DAY, codeHash, id),
  ]);
  if (result[0].meta.changes === 0) {
    const prior = await env.DB.prepare("SELECT redeemed_by FROM invites WHERE code_hash = ?")
      .bind(codeHash).first<{ redeemed_by: string | null }>();
    if (prior?.redeemed_by !== id) throw new ApiError(403, "invalid_invite", "This invitation is invalid, expired, or belongs to another email.");
  }
  return account(env, id, modern);
}

export async function consent(env: Env, id: string, input: unknown, modern = false): Promise<Response> {
  const { enabled, version } = z.object({ enabled: z.boolean(), version: z.literal(CAPTURE_VERSION) }).parse(input);
  const now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE members SET capture = ?, consent_epoch = consent_epoch + 1
      WHERE id = ? AND deleted_at IS NULL AND (revoked = 0 OR ? = 0)`).bind(Number(enabled), id, Number(enabled)),
    env.DB.prepare(`INSERT INTO consents(member_id, version, enabled, created_at)
      SELECT id, ?, ?, ? FROM members WHERE id = ? AND deleted_at IS NULL AND (revoked = 0 OR ? = 0)`)
      .bind(version, Number(enabled), now, id, Number(enabled)),
  ]);
  if (!result[0].meta.changes) throw new ApiError(403, "access_denied", "An active pilot account is required.");
  return account(env, id, modern);
}

export async function rateLimit(env: Env, key: string, limit: number, windowMs: number): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(`INSERT INTO api_limits(key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
    RETURNING count`).bind(key, now + windowMs, now, now).first<{ count: number }>();
  if (!row || row.count > limit) throw new ApiError(429, "rate_limited", "Too many requests. Please wait a minute.");
}
