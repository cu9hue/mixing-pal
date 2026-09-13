import { ApiError, Env, MODEL, hash, privateHash } from "./env";
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

export async function reserve(env: Env, memberId: string, input: CompletionInput): Promise<void> {
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
      env.DB.prepare(`INSERT INTO turns(id, member_id, created_at, updated_at, app_version, wire_version, consent_epoch, capture)
        SELECT ?, id, ?, ?, ?, ?, consent_epoch, CASE WHEN consent_epoch = ? THEN capture ELSE 0 END FROM members WHERE id = ?
        ON CONFLICT(id) DO NOTHING`)
        .bind(input.turn_id, now, now, input.app_version, input.wire_version, input.capture_epoch ?? null, memberId),
      env.DB.prepare(`INSERT INTO requests(id, turn_id, member_id, round, body_hash, prompt_hash, tool_hash,
        policy_version, reserved, status, created_at, updated_at, model)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`)
        .bind(input.request_id, input.turn_id, memberId, input.round, bodyHash, promptHash, toolHash,
          POLICY_VERSION, RESERVATION, now, now, MODEL),
      env.DB.prepare("UPDATE turns SET updated_at = ? WHERE id = ? AND member_id = ?").bind(now, input.turn_id, memberId),
    ]);
  } catch (error) {
    const text = String(error);
    const errors: [string, number, string][] = [
      ["access_denied", 403, "Your pilot access has ended or was revoked."],
      ["turn_closed", 409, "This conversation turn has ended. Ask again to start a new turn."],
      ["invalid_round", 409, "This turn cannot start another model request."],
      ["allowance_exhausted", 402, "The pilot allowance is used up. Contact Mixing Pal for access."],
      ["busy", 429, "Another request is still running. Please wait before asking again."],
      ["service_paused", 503, "Model access is temporarily paused."],
      ["UNIQUE constraint", 409, "This request has already been submitted."],
    ];
    for (const [code, status, message] of errors) {
      if (text.includes(code)) throw new ApiError(status, code === "UNIQUE constraint" ? "duplicate_request" : code, message);
    }
    throw error;
  }
}

export async function settle(env: Env, id: string, cost: number, details: {
  generationId?: string; provider?: string; usage?: unknown; finishReason?: string | null;
  errorCode?: string; durationMs?: number;
} = {}): Promise<void> {
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error("Invalid settlement cost");
  await env.DB.prepare(`UPDATE requests SET status = 'settled', cost = ?, updated_at = ?,
    generation_id = COALESCE(?, generation_id), provider = ?, usage = ?, finish_reason = ?, error_code = ?, duration_ms = ?
    WHERE id = ? AND status != 'settled'`)
    .bind(cost, Date.now(), details.generationId ?? null, details.provider ?? null,
      details.usage ? JSON.stringify(details.usage) : null, details.finishReason ?? null,
      details.errorCode ?? null, details.durationMs ?? null, id).run();
}

export async function unknown(env: Env, id: string, errorCode: string): Promise<void> {
  await env.DB.prepare(`UPDATE requests SET status = 'unknown', error_code = ?, updated_at = ?
    WHERE id = ? AND status != 'settled'`).bind(errorCode, Date.now(), id).run();
  console.error(JSON.stringify({ event: "usage_unknown", request_id: id, code: errorCode }));
}
