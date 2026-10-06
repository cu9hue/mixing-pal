import { account } from "./account";
import { incomplete, optionalCapture, ownedTurn } from "./capture";
import { ApiError, Env, FIRST_DATA_TIMEOUT, IDLE_TIMEOUT, MIN_RUNTIME, SETTLE_TIMEOUT, json } from "./env";
import { admissionDeadline, enrich, reserve, settle, settleProvisional } from "./ledger";
import { completionInput, providerBody, routes, usageSchema } from "./policy";
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
const validId = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 200 ? value : undefined;

/** A ledger write that cannot finish in time is left to the lease cleanup; she still gets her answer. */
async function bounded(write: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try { await Promise.race([write, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), SETTLE_TIMEOUT); })]); }
  catch (error) { console.error(JSON.stringify({ event: "settlement_deferred", error: String(error) })); }
  finally { clearTimeout(timer); }
}

export async function complete(env: Env, memberId: string, input: unknown, ctx: ExecutionContext, receivedAt: number): Promise<Response> {
  const request = completionInput.parse(input);
  if (env.INFERENCE_ENABLED !== "true" || !env.OPENROUTER_KEY) {
    throw new ApiError(503, "service_paused", "Model access is not enabled yet.");
  }
  const body = providerBody(request, await routes());
  const deadline = admissionDeadline(receivedAt);
  await reserve(env, memberId, request, deadline);
  const turn = await ownedTurn(env, request.turn_id, memberId);
  const id = request.request_id;
  const start = Date.now();
  if (!(await dispatchStatement(env, id, start).run()).meta.changes) {
    await bounded(settle(env, id, 0, { errorCode: "not_dispatched" }));
    throw interrupted();
  }
  const capture = (kind: "model" | "model_failure", extra: Record<string, unknown>) =>
    optionalCapture(env, turn, crypto.randomUUID(), JSON.parse(JSON.stringify({ kind, request_id: id, round: request.round,
      source: "proxy", body, at: start, duration_ms: Date.now() - start, ...extra }).split(env.OPENROUTER_KEY).join("[redacted]")), ctx);
  const controller = new AbortController();
  const abortAt = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
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
    await bounded(settleProvisional(env, id, "provider_interrupted"));
    await incomplete(env, turn.id);
    await capture("model_failure", { error: "provider_interrupted" });
    throw interrupted();
  }
  const headerId = validId(response.headers.get("x-generation-id"));
  if (headerId) await bounded(enrich(env, id, { generationId: headerId }));
  if (!response.ok) {
    clearTimeout(abortAt);
    await response.body?.cancel();
    await bounded(ZERO_COST.includes(response.status)
      ? settle(env, id, 0, { errorCode: `upstream_${response.status}` })
      : settleProvisional(env, id, `upstream_${response.status}`));
    await incomplete(env, turn.id);
    await capture("model_failure", { status: response.status });
    throw failed();
  }
  const end: StreamEnd = response.body
    ? await readCompletionStream(response.body, { firstDataBy: start + FIRST_DATA_TIMEOUT, idleMs: IDLE_TIMEOUT, deadline,
        onId: (chunkId) => {
          if (!headerId) void bounded(enrich(env, id, { generationId: validId(chunkId) }));
          else if (chunkId !== headerId) console.error(JSON.stringify({ event: "generation_id_mismatch", request_id: id }));
        } })
    : { kind: "failed", reason: "truncated", response: { content: "", reasoning: "", finishReason: null, toolCalls: [] } };
  clearTimeout(abortAt);
  controller.abort();
  const answer: Assembled = end.response;
  const usage = usageSchema.safeParse(answer.usage);
  const details = { provider: answer.provider, finishReason: answer.finishReason, durationMs: Date.now() - start,
    usage: usage.success ? usage.data : undefined };
  if (usage.success) await bounded(settle(env, id, Math.ceil(usage.data.cost * 1_000_000), details));
  else await bounded(settleProvisional(env, id, end.kind === "complete" ? "missing_usage" : `stream_${end.reason}`));
  // Captures keep OpenRouter's non-stream shape, which the turn export reads.
  const raw = { id: answer.id, model: answer.model, provider: answer.provider, usage: answer.usage, choices: [{ finish_reason: answer.finishReason,
    message: { content: answer.content, reasoning: answer.reasoning, tool_calls: answer.toolCalls } }] };
  await capture(end.kind === "complete" ? "model" : "model_failure", { response: raw, reason: end.kind === "failed" ? end.reason : undefined });
  if (end.kind === "failed") {
    await incomplete(env, turn.id);
    throw end.reason === "timeout" || end.reason === "truncated" ? interrupted() : failed();
  }
  const text = answer.content;
  const toolCalls = releasedToolCalls(end);
  if (!text.trim() && toolCalls.length === 0) throw new ApiError(502, "empty_completion", "The model returned an empty reply. Please try again.");
  const view = await (await account(env, memberId)).json();
  const reply = JSON.stringify({ text, tool_calls: toolCalls, turn_id: request.turn_id, request_id: id,
    capture: Boolean(turn.capture), consent_epoch: turn.consent_epoch, account: view }).split(env.OPENROUTER_KEY).join("[redacted]");
  if (new TextEncoder().encode(reply).length > MAX_REPLY) throw failed();
  return json(JSON.parse(reply));
}
