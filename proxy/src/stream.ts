import { createParser } from "eventsource-parser";
import { toolCall, usageSchema } from "./policy";

export interface Assembled {
  id?: string; model?: string; provider?: string; content: string; reasoning: string;
  finishReason: string | null;
  toolCalls: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  usage?: unknown;
}
export type StreamEnd = { kind: "complete"; response: Assembled }
  | { kind: "failed"; reason: "truncated" | "error" | "timeout" | "limit" | "malformed"; response: Assembled; error?: unknown };

export const STREAM_LIMITS = { wireBytes: 16 * 1024 * 1024, eventBytes: 1024 * 1024, toolCalls: 32, argumentChars: 65_536 };

class StreamFailure extends Error {
  constructor(public reason: "error" | "limit" | "malformed" | "truncated", public detail?: unknown) { super(reason); }
}

interface Partial { id?: string; type?: string; name?: string; arguments: string }

/** Reads OpenRouter's server-sent events into one response; never throws. */
export async function readCompletionStream(body: ReadableStream<Uint8Array>, options: {
  firstDataBy: number; idleMs: number; deadline: number; onId?: (id: string) => void;
  limits?: typeof STREAM_LIMITS; now?: () => number;
}): Promise<StreamEnd> {
  const limits = options.limits ?? STREAM_LIMITS;
  const now = options.now ?? Date.now;
  const response: Assembled = { content: "", reasoning: "", finishReason: null, toolCalls: [] };
  const calls = new Map<number, Partial>();
  let wire = 0, sawData = false, done = false, ending = false, failure: StreamFailure | undefined;

  const apply = (data: string) => {
    if (data.length > limits.eventBytes) throw new StreamFailure("limit");
    if (data === "[DONE]") { done = true; return; }
    let event: Record<string, unknown>;
    try { event = JSON.parse(data); } catch { throw new StreamFailure("malformed"); }
    sawData = true;
    if (typeof event.id === "string" && response.id === undefined) { response.id = event.id; options.onId?.(event.id); }
    if (typeof event.model === "string") response.model ??= event.model;
    if (typeof event.provider === "string") response.provider ??= event.provider;
    // A later malformed usage, as on an error event, must not erase the cost already reported.
    if (usageSchema.safeParse(event.usage).success) response.usage = event.usage;
    if (event.error) throw new StreamFailure("error", event.error);
    const choice = (Array.isArray(event.choices) ? event.choices[0] : undefined) as Record<string, unknown> | undefined;
    if (!choice) return;
    if (choice.index !== undefined && choice.index !== 0) throw new StreamFailure("malformed");
    if (typeof choice.finish_reason === "string") {
      if (choice.finish_reason === "error") throw new StreamFailure("error");
      response.finishReason = choice.finish_reason;
    }
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    if (typeof delta.content === "string") response.content += delta.content;
    if (typeof delta.reasoning === "string") response.reasoning += delta.reasoning;
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls as Record<string, unknown>[] : []) {
      if (!Number.isInteger(raw.index) || (raw.index as number) < 0) throw new StreamFailure("malformed");
      const index = raw.index as number;
      const call = calls.get(index) ?? { arguments: "" };
      if (!calls.has(index)) { if (calls.size >= limits.toolCalls) throw new StreamFailure("limit"); calls.set(index, call); }
      const fn = (raw.function ?? {}) as Record<string, unknown>;
      for (const [key, value] of [["id", raw.id], ["type", raw.type], ["name", fn.name]] as const) {
        if (typeof value !== "string") continue;
        if (call[key] !== undefined && call[key] !== value) throw new StreamFailure("malformed");
        call[key] = value;
      }
      if (typeof fn.arguments === "string") {
        call.arguments += fn.arguments;
        if (call.arguments.length > limits.argumentChars) throw new StreamFailure("limit");
      }
    }
  };

  const parser = createParser({ onEvent: (event) => { if (!failure && !done) { try { if (ending) throw new StreamFailure("truncated"); apply(event.data); } catch (e) { failure = e as StreamFailure; } } } });
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const finish = (end: StreamEnd): StreamEnd => {
    response.toolCalls = [...calls.entries()].sort(([a], [b]) => a - b)
      .flatMap(([, c]) => { const parsed = toolCall.safeParse({ id: c.id, type: c.type, function: { name: c.name, arguments: c.arguments } });
        return parsed.success ? [parsed.data] : []; });
    return end;
  };
  try {
    for (;;) {
      const wait = Math.min(sawData ? Infinity : options.firstDataBy - now(), options.idleMs, options.deadline - now());
      if (wait <= 0) return finish({ kind: "failed", reason: "timeout", response });
      let timer: ReturnType<typeof setTimeout> | null = null;
      const next = await Promise.race([reader.read(), new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), wait); })]);
      clearTimeout(timer);
      if (next === "timeout") return finish({ kind: "failed", reason: "timeout", response });
      if (next.done) {
        parser.feed(decoder.decode());
        // reset({ consume: true }) drops a pending event. A closing blank line dispatches it, and that means truncation.
        ending = true;
        parser.feed("\n\n");
        break;
      }
      wire += next.value.length;
      if (wire > limits.wireBytes) return finish({ kind: "failed", reason: "limit", response });
      parser.feed(decoder.decode(next.value, { stream: true }));
      if (failure) return finish({ kind: "failed", reason: failure.reason, response, error: failure.detail });
      if (done) break;
    }
  } catch (error) {
    return finish({ kind: "failed", reason: "truncated", response, error });
  } finally {
    reader.cancel().catch(() => {});
  }
  if (failure) return finish({ kind: "failed", reason: failure.reason, response, error: failure.detail });
  return finish(response.finishReason ? { kind: "complete", response } : { kind: "failed", reason: "truncated", response });
}

/** Tool calls go to the app only from a complete stream that ended to call them, or stopped. */
export function releasedToolCalls(end: StreamEnd): Assembled["toolCalls"] {
  if (end.kind !== "complete" || !["tool_calls", "stop"].includes(end.response.finishReason ?? "")) return [];
  return end.response.toolCalls;
}
