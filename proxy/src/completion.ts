import { account } from "./account";
import { incomplete, optionalCapture, ownedTurn } from "./capture";
import { ApiError, Env, MAX_BODY, MODEL_TIMEOUT, json, readJson } from "./env";
import { admissionDeadline, reserve, settle, settleProvisional } from "./ledger";
import { completionInput, providerBody, responseSchema, routes, usageSchema } from "./policy";

export async function complete(env: Env, memberId: string, input: unknown, ctx: ExecutionContext, receivedAt: number): Promise<Response> {
  const request = completionInput.parse(input);
  if (env.INFERENCE_ENABLED !== "true" || !env.OPENROUTER_KEY) {
    throw new ApiError(503, "service_paused", "Model access is not enabled yet.");
  }
  const body = providerBody(request, await routes());
  const deadline = admissionDeadline(receivedAt);
  await reserve(env, memberId, request, deadline);
  const turn = await ownedTurn(env, request.turn_id, memberId);
  await env.DB.prepare("UPDATE requests SET status = 'dispatched', updated_at = ? WHERE id = ? AND status = 'reserved'")
    .bind(Date.now(), request.request_id).run();
  const start = Date.now();
  let raw: unknown;
  let status: number;
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENROUTER_KEY}`, "Content-Type": "application/json",
        "HTTP-Referer": "https://mixingpal.com", "X-OpenRouter-Title": "Mixing Pal" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(MODEL_TIMEOUT),
    });
    status = response.status;
    raw = await readJson(response, MAX_BODY * 2);
  } catch {
    await settleProvisional(env, request.request_id, "provider_interrupted");
    await incomplete(env, turn.id);
    await optionalCapture(env, turn, crypto.randomUUID(), { kind: "model_failure", request_id: request.request_id,
      round: request.round, source: "proxy", body, error: "provider_interrupted", at: start }, ctx);
    throw new ApiError(504, "completion_unknown", "The reply was interrupted. Its usage is being checked; it has not been retried.");
  }
  const durationMs = Date.now() - start;
  if (status < 200 || status >= 300) {
    if ([400, 401, 402, 403, 404, 413, 422, 429].includes(status)) {
      await settle(env, request.request_id, 0, { errorCode: `upstream_${status}`, durationMs });
    } else {
      await settleProvisional(env, request.request_id, `upstream_${status}`);
    }
    await incomplete(env, turn.id);
    const response = JSON.parse(JSON.stringify(raw).split(env.OPENROUTER_KEY).join("[redacted]"));
    await optionalCapture(env, turn, crypto.randomUUID(), { kind: "model_failure", request_id: request.request_id,
      round: request.round, source: "proxy", body, response, status, at: start, duration_ms: durationMs }, ctx);
    throw new ApiError(502, "provider_failed", "The model could not answer. Please try again later.");
  }
  // A provider can echo a credential even in a malformed success response.
  // Never copy that credential into a trace, an error or the webview.
  const safe = JSON.parse(JSON.stringify(raw).split(env.OPENROUTER_KEY).join("[redacted]"));
  const parsed = responseSchema.safeParse(safe);
  const metadata = safe && typeof safe === "object" ? safe as Record<string, unknown> : {};
  const usage = usageSchema.safeParse(metadata.usage);
  const generationId = typeof metadata.id === "string" && metadata.id.length <= 200 ? metadata.id : undefined;
  if (generationId) {
    await env.DB.prepare("UPDATE requests SET generation_id = ? WHERE id = ?").bind(generationId, request.request_id).run();
  }
  if (usage.success) {
    await settle(env, request.request_id, Math.ceil(usage.data.cost * 1_000_000), {
      generationId, usage: usage.data, durationMs,
      provider: parsed.success ? parsed.data.provider : undefined,
      finishReason: parsed.success ? parsed.data.choices[0].finish_reason : undefined,
      errorCode: parsed.success ? undefined : "invalid_completion",
    });
  } else {
    await settleProvisional(env, request.request_id, "missing_usage");
  }
  await optionalCapture(env, turn, crypto.randomUUID(), { kind: "model", request_id: request.request_id,
    round: request.round, source: "proxy", body, response: safe, at: start, duration_ms: durationMs }, ctx);
  if (!parsed.success) throw new ApiError(502, "invalid_completion", "The model returned an unreadable reply.");
  const choice = parsed.data.choices[0];
  const text = choice.message.content ?? "";
  const toolCalls = choice.message.tool_calls ?? [];
  if (!text.trim() && toolCalls.length === 0) throw new ApiError(502, "empty_completion", "The model returned an empty reply. Please try again.");
  // A tool round with unknown usage cannot advance past the held request.
  if (!usage.success && toolCalls.length > 0) {
    throw new ApiError(503, "completion_unknown", "Usage for this request is being checked. The turn has stopped here.");
  }
  const view = await (await account(env, memberId)).json();
  return json({ text, tool_calls: toolCalls, turn_id: request.turn_id, request_id: request.request_id,
    capture: Boolean(turn.capture), consent_epoch: turn.consent_epoch, account: view });
}
