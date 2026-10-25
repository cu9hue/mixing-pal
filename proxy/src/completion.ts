import { account } from "./account";
import { incomplete, optionalCapture, ownedTurn } from "./capture";
import { ApiError, Env, FIRST_DATA_TIMEOUT, IDLE_TIMEOUT, MIN_RUNTIME, RESPONSE_BUDGET, SETTLE_TIMEOUT, json } from "./env";
import { admissionDeadline, enrich, reserve, settle, settleProvisional } from "./ledger";
import { completionInput, providerBody, serving, usageSchema } from "./policy";
import { Assembled, readCompletionStream, releasedToolCalls, StreamEnd } from "./stream";

const ZERO_COST = [400, 401, 402, 403, 404, 413, 422, 429];
const MAX_REPLY = 1_572_864;

export const canDispatch = (deadline: number, now: number) => deadline - now >= MIN_RUNTIME;
export function dispatchStatement(env: Env, id: string, now: number): D1PreparedStatement {
  return env.DB.prepare(`UPDATE requests SET status = 'dispatched', updated_at = ?
    WHERE id = ? AND status = 'reserved' AND deadline - ? >= ?`).bind(now, id, now, MIN_RUNTIME);
}
const interrupted = () => new ApiError(504, "completion_interrupted", "The reply was interrupted. It has not been retried. You can ask again.");
const failed = () => new ApiError(502, "provider_failed", "The model could not answer. Please try again.");
const validId = (value: unknown, secret: string) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes(secret) ? value : undefined;

/** Work that cannot finish before the reply is due keeps running after it; the lease cleanup covers a write that never lands. */
async function bounded<T>(work: Promise<T>, respondBy: number, ctx: ExecutionContext, event = "settlement_deferred"): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  ctx.waitUntil(work.catch(() => {}));
  const wait = Math.max(0, Math.min(SETTLE_TIMEOUT, respondBy - Date.now()));
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), wait); })]); }
  catch (error) { console.error(JSON.stringify({ event, error: String(error) })); return undefined; }
  finally { clearTimeout(timer); }
}

export async function complete(env: Env, memberId: string, input: unknown, ctx: ExecutionContext, receivedAt: number,
  modern = false): Promise<Response> {
  const request = completionInput.parse(input);
  if (env.INFERENCE_ENABLED !== "true" || !env.OPENROUTER_KEY) {
    throw new ApiError(503, "service_paused", "Model access is not enabled yet.");
  }
  const [policy, only] = await serving(request.app_version);
  const body = providerBody(request, policy, only);
  const deadline = admissionDeadline(receivedAt);
  const respondBy = receivedAt + RESPONSE_BUDGET;
  await reserve(env, memberId, request, deadline, policy);
  const turn = await ownedTurn(env, request.turn_id, memberId);
  const id = request.request_id;
  const dispatched = (await dispatchStatement(env, id, Date.now()).run()).meta.changes;
  // A late D1 reply must not start provider work near the deadline; the call was never sent, so it costs 0.
  const start = Date.now();
  if (!dispatched || !canDispatch(deadline, start)) {
    await bounded(settle(env, id, 0, { errorCode: "not_dispatched" }), respondBy, ctx);
    throw interrupted();
  }
  const capture = (kind: "model" | "model_failure", extra: Record<string, unknown>) =>
    optionalCapture(env, turn, crypto.randomUUID(), JSON.parse(JSON.stringify({ kind, request_id: id, round: request.round,
      source: "proxy", body, at: start, duration_ms: Date.now() - start, ...extra }).split(env.OPENROUTER_KEY).join("[redacted]")), ctx);
  const firstDataBy = start + FIRST_DATA_TIMEOUT;
  const controller = new AbortController();
  const abortAt = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  // Headers count as first data: a silent upstream must not hold capacity until the deadline.
  const headersAt = setTimeout(() => controller.abort(), Math.max(0, firstDataBy - Date.now()));
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}`, "Content-Type": "application/json",
        "HTTP-Referer": "https://mixingpal.com", "X-OpenRouter-Title": "Mixing Pal" },
      body: JSON.stringify(body), signal: controller.signal,
    });
  } catch {
    clearTimeout(abortAt);
    clearTimeout(headersAt);
    await bounded(settleProvisional(env, id, "provider_interrupted"), respondBy, ctx);
    await bounded(incomplete(env, turn.id), respondBy, ctx, "turn_mark_deferred");
    await bounded(capture("model_failure", { error: "provider_interrupted" }), respondBy, ctx, "capture_deferred");
    throw interrupted();
  }
  clearTimeout(headersAt);
  const headerId = validId(response.headers.get("x-generation-id"), env.OPENROUTER_KEY);
  if (headerId) await bounded(enrich(env, id, { generationId: headerId }), respondBy, ctx);
  if (!response.ok) {
    console.error(JSON.stringify({ event: "upstream_failed", request_id: id, status: response.status }));
    clearTimeout(abortAt);
    void response.body?.cancel().catch(() => {});
    await bounded<unknown>(ZERO_COST.includes(response.status)
      ? settle(env, id, 0, { errorCode: `upstream_${response.status}` })
      : settleProvisional(env, id, `upstream_${response.status}`), respondBy, ctx);
    await bounded(incomplete(env, turn.id), respondBy, ctx, "turn_mark_deferred");
    await bounded(capture("model_failure", { status: response.status }), respondBy, ctx, "capture_deferred");
    throw failed();
  }
  const end: StreamEnd = response.body
    ? await readCompletionStream(response.body, { firstDataBy, idleMs: IDLE_TIMEOUT, deadline,
        onId: (chunkId) => {
          if (!headerId) void bounded(enrich(env, id, { generationId: validId(chunkId, env.OPENROUTER_KEY) }), respondBy, ctx);
          else if (chunkId !== headerId) console.error(JSON.stringify({ event: "generation_id_mismatch", request_id: id }));
        } })
    : { kind: "failed", reason: "truncated", response: { content: "", reasoning: "", finishReason: null, toolCalls: [] } };
  clearTimeout(abortAt);
  controller.abort();
  const answer: Assembled = end.response;
  const usage = usageSchema.safeParse(answer.usage);
  // Stored metadata is exported, so provider text carrying the credential is dropped; usageSchema keeps only numbers.
  const clean = <T extends string | null>(value?: T) => value?.includes(env.OPENROUTER_KEY) ? undefined : value;
  const details = { provider: clean(answer.provider), finishReason: clean(answer.finishReason), durationMs: Date.now() - start,
    usage: usage.success ? usage.data : undefined, errorCode: end.kind === "failed" ? `stream_${end.reason}` : undefined };
  if (usage.success) await bounded(settle(env, id, Math.ceil(usage.data.cost * 1_000_000), details), respondBy, ctx);
  else await bounded(settleProvisional(env, id, end.kind === "complete" ? "missing_usage" : `stream_${end.reason}`), respondBy, ctx);
  // Captures keep OpenRouter's non-stream shape, which the turn export reads.
  const raw = { id: answer.id, model: answer.model, provider: answer.provider, usage: answer.usage, choices: [{ finish_reason: answer.finishReason,
    message: { content: answer.content, reasoning: answer.reasoning, tool_calls: answer.toolCalls } }] };
  await bounded(capture(end.kind === "complete" ? "model" : "model_failure", { response: raw, reason: end.kind === "failed" ? end.reason : undefined }),
    respondBy, ctx, "capture_deferred");
  if (end.kind === "failed") {
    await bounded(incomplete(env, turn.id), respondBy, ctx, "turn_mark_deferred");
    throw end.reason === "timeout" || end.reason === "truncated" ? interrupted() : failed();
  }
  const text = answer.content;
  const toolCalls = releasedToolCalls(end);
  if (!text.trim() && toolCalls.length === 0) throw new ApiError(502, "empty_completion", "The model returned an empty reply. Please try again.");
  // Past the budget she gets the answer without the account view; the app reads it on its next poll.
  const view = await bounded(account(env, memberId, modern).then((r) => r.json()), respondBy, ctx, "account_view_skipped");
  const reply = JSON.stringify({ text, tool_calls: toolCalls, turn_id: request.turn_id, request_id: id,
    capture: Boolean(turn.capture), consent_epoch: turn.consent_epoch, account: view }).split(env.OPENROUTER_KEY).join("[redacted]");
  if (new TextEncoder().encode(reply).length > MAX_REPLY) throw failed();
  return json(JSON.parse(reply));
}
