import { ApiError, CAPTURE_VERSION, Env, MODEL, MODEL_TIMEOUT, RECONCILE_DELAY, RESPONSE_BUDGET, SETTLE_MARGIN, hash, privateHash } from "./env";
import { CompletionInput, POLICY_VERSION, RESERVATION } from "./policy";

export interface UsageRequest {
  id: string;
  member_id: string;
  turn_id: string;
  status: string;
  body_hash: string;
  generation_id: string | null;
  reserved: number;
}

/** The model's absolute end: never past the handler's own budget for answering the app. */
export function admissionDeadline(receivedAt: number, now = Date.now()): number {
  return Math.min(now + MODEL_TIMEOUT, receivedAt + RESPONSE_BUDGET - SETTLE_MARGIN);
}

export async function reserve(env: Env, memberId: string, input: CompletionInput, deadline: number): Promise<void> {
  const now = Date.now();
  const [bodyHash, promptHash, toolHash] = await Promise.all([
    privateHash(env.AUTH_SECRET, JSON.stringify(input)),
    hash(JSON.stringify(input.body.messages.filter((m) => m.role === "system"))),
    hash(JSON.stringify(input.body.tools)),
  ]);
  const prior = await env.DB.prepare("SELECT * FROM requests WHERE id = ?").bind(input.request_id).first<UsageRequest>();
  if (prior) {
    if (prior.member_id !== memberId || prior.body_hash !== bodyHash) {
      throw new ApiError(409, "request_conflict", "This request identifier has already been used.");
    }
    throw new ApiError(409, "duplicate_request", `This generation is ${prior.status}. It will not be started again.`);
  }
  try {
    await env.DB.batch([
      env.DB.prepare("UPDATE turns SET status = 'superseded' WHERE member_id = ? AND id != ? AND status = 'running'")
        .bind(memberId, input.turn_id),
      expiredStatement(env, now),
      env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
        SELECT ?, id, ?, ?, ?, ?, consent_epoch,
          CASE WHEN consent_epoch = ? AND capture = 1 AND EXISTS (
            SELECT 1 FROM consents WHERE member_id = members.id AND version = ? AND enabled = 1
              AND id = (SELECT MAX(id) FROM consents WHERE member_id = members.id)
          ) THEN 1 ELSE 0 END FROM members WHERE id = ?
        ON CONFLICT(id) DO NOTHING`)
        .bind(input.turn_id, now, now, input.app_version, input.wire_version, input.capture_epoch ?? null, CAPTURE_VERSION, memberId),
      env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash,
        policy_version, reserved, status, created_at, updated_at, model, deadline, lease_until)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?, ?, ?)`)
        .bind(input.request_id, input.turn_id, memberId, input.round, bodyHash, promptHash, toolHash,
          POLICY_VERSION, RESERVATION, now, now, MODEL, deadline, deadline + SETTLE_MARGIN),
      env.DB.prepare("UPDATE turns SET updated_at = ? WHERE id = ? AND member_id = ?").bind(now, input.turn_id, memberId),
    ]);
  } catch (error) {
    const text = String(error);
    const errors: [string, number, string][] = [
      ["access_denied", 403, "Your pilot access has ended or was revoked."],
      ["turn_closed", 409, "This conversation turn has ended. Ask again to start a new turn."],
      ["invalid_round", 409, "This turn cannot start another model request."],
      ["allowance_exhausted", 402, "The pilot allowance is used up. Contact Mixing Pal for access."],
      ["busy", 429, "Mixing Pal is busy. Try again in a moment."],
      ["service_paused", 503, "Model access is temporarily paused."],
      ["budget_exhausted", 503, "Model access is temporarily paused."],
      ["lease_required", 503, "Model access is temporarily paused."],
      ["UNIQUE constraint", 409, "This request has already been submitted."],
    ];
    for (const [code, status, message] of errors) {
      if (text.includes(code)) throw new ApiError(status, code === "UNIQUE constraint" ? "duplicate_request"
        : ["budget_exhausted", "lease_required"].includes(code) ? "service_paused" : code, message);
    }
    throw error;
  }
}

export type Settlement = "applied" | "already_final" | "conflict" | "not_found";
export interface SettleDetails {
  generationId?: string; provider?: string; usage?: unknown; finishReason?: string | null;
  errorCode?: string; durationMs?: number;
}

function enrichStatement(env: Env, id: string, d: SettleDetails): D1PreparedStatement {
  return env.DB.prepare(`UPDATE requests SET generation_id = COALESCE(generation_id, ?), provider = COALESCE(provider, ?),
    usage = COALESCE(usage, ?), finish_reason = COALESCE(finish_reason, ?), duration_ms = COALESCE(duration_ms, ?)
    WHERE id = ?`).bind(d.generationId ?? null, d.provider ?? null, d.usage ? JSON.stringify(d.usage) : null,
    d.finishReason ?? null, d.durationMs ?? null, id);
}

/** Metadata only; a cost never changes through here. */
export async function enrich(env: Env, id: string, details: SettleDetails): Promise<void> {
  await enrichStatement(env, id, details).run();
}

/** A known cost: final for an open or provisional row; a different cost on a final row is a conflict. */
export async function settle(env: Env, id: string, cost: number, details: SettleDetails = {}, source = "stream"): Promise<Settlement> {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Invalid settlement cost");
  const [result] = await env.DB.batch([
    env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 0, cost = ?, updated_at = ?,
      error_code = COALESCE(?, error_code) WHERE id = ? AND (status != 'settled' OR provisional = 1)`)
      .bind(cost, Date.now(), details.errorCode ?? null, id),
    enrichStatement(env, id, details),
  ]);
  if (result.meta.changes) return "applied";
  const row = await env.DB.prepare("SELECT cost FROM requests WHERE id = ?").bind(id).first<{ cost: number }>();
  if (!row) return "not_found";
  if (row.cost === cost) return "already_final";
  await recordConflict(env, id, source, row.cost, cost);
  return "conflict";
}

/** The call ended and its cost is unknown: Mixing Pal pays it until reconciliation. */
export async function settleProvisional(env: Env, id: string, errorCode: string, now = Date.now()): Promise<boolean> {
  const result = await env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = 1, cost = reserved,
    error_code = ?, updated_at = ?, reconcile_after = ? WHERE id = ? AND status != 'settled'`)
    .bind(errorCode, now, now + RECONCILE_DELAY, id).run();
  if (result.meta.changes) console.error(JSON.stringify({ event: "usage_provisional", request_id: id, code: errorCode }));
  return Boolean(result.meta.changes);
}

/** Expired dispatched calls and legacy unknown rows settle provisional; an expired reserved row was never sent, so it settles final at 0. */
export function expiredStatement(env: Env, now: number): D1PreparedStatement {
  return env.DB.prepare(`UPDATE requests SET status = 'settled', provisional = iif(status = 'reserved', 0, 1),
    cost = iif(status = 'reserved', 0, reserved), error_code = iif(status = 'reserved', 'not_dispatched', 'worker_interrupted'),
    updated_at = ?, reconcile_after = iif(status = 'reserved', reconcile_after, ?)
    WHERE (status = 'unknown' OR (status IN ('reserved', 'dispatched') AND lease_until <= ?))
    RETURNING id`).bind(now, now + RECONCILE_DELAY, now);
}

export async function settleExpired(env: Env, now: number): Promise<number> {
  // meta.changes also counts the rows the triggers update, so count the returned rows.
  return (await expiredStatement(env, now).all()).results.length;
}

/** Pruning can delete the request first; then nothing is recorded and the result is false. */
export async function recordConflict(env: Env, id: string, source: string, recorded: number, reported: number): Promise<boolean> {
  const [, conflict] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO cost_conflicts(request_id, source, recorded, reported, created_at)
      SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM requests WHERE id = ?) ON CONFLICT(request_id, source, reported) DO NOTHING`)
      .bind(id, source, recorded, reported, Date.now(), id),
    env.DB.prepare("SELECT 1 FROM cost_conflicts WHERE request_id = ? AND source = ? AND reported = ?").bind(id, source, reported),
  ]);
  if (!conflict.results.length) return false;
  console.error(JSON.stringify({ event: "cost_conflict", request_id: id, source, recorded, reported }));
  return true;
}

export async function recover(env: Env, memberId: string | undefined, spent: number, reason: string): Promise<void> {
  const table = memberId === undefined ? "budget" : "members";
  const guard = `id = ? AND recovery_required = 1 AND reserved = 0 AND spent <= ?
    AND EXISTS (SELECT 1 FROM budget WHERE paused = 1 AND recovery_required = 1)
    AND NOT EXISTS (SELECT 1 FROM requests WHERE status != 'settled'${memberId === undefined ? "" : " AND member_id = members.id"})
    AND NOT EXISTS (SELECT 1 FROM requests WHERE provisional = 1${memberId === undefined ? "" : " AND member_id = members.id"})
    ${memberId === undefined ? "AND NOT EXISTS (SELECT 1 FROM members WHERE recovery_required = 1) AND (SELECT COALESCE(SUM(spent), 0) FROM members) <= ?" : ""}`;
  const values = memberId === undefined ? [1, spent, spent] : [memberId, spent];
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO operator_actions(action, target, created_at, detail)
      SELECT 'recover', ?, ?, ? FROM ${table} WHERE ${guard}`)
      .bind(memberId ?? "service", Date.now(), JSON.stringify({ spent_micro_usd: spent, reason }), ...values),
    env.DB.prepare(`UPDATE ${table} SET spent = ?, recovery_required = 0 WHERE ${guard}`).bind(spent, ...values),
  ]);
  if (!result[1].meta.changes) {
    throw new ApiError(409, "recovery_not_ready", "Resolve provisional costs first, recover each account before the global budget, and never reduce recorded spending.");
  }
}
