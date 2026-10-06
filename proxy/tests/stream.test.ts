import { describe, expect, test } from "vitest";
import { readCompletionStream, releasedToolCalls, STREAM_LIMITS } from "../src/stream";

const enc = new TextEncoder();
function sse(events: (object | string)[], tail = "data: [DONE]\n\n"): string {
  return events.map((e) => typeof e === "string" ? e : `data: ${JSON.stringify(e)}\n\n`).join("") + tail;
}
function body(text: string, cuts: number[] = []): ReadableStream<Uint8Array> {
  const bytes = enc.encode(text);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const c of [...cuts, bytes.length]) { parts.push(bytes.slice(at, c)); at = c; }
  return new ReadableStream({ start(ctl) { for (const p of parts) if (p.length) ctl.enqueue(p); ctl.close(); } });
}
const opts = (extra = {}) => ({ firstDataBy: Date.now() + 60_000, idleMs: 60_000, deadline: Date.now() + 270_000, ...extra });
const chunk = (delta: object, finish: string | null = null, extra = {}) =>
  ({ id: "gen-1", provider: "Inceptron", choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
const usage = { cost: 0.001, prompt_tokens: 10, completion_tokens: 2 };

describe("stream reader", () => {
  const text = sse([chunk({ content: "Hé" }), chunk({ content: "llo" }), chunk({ reasoning: "think" }),
    chunk({}, "stop"), chunk({}, "stop", { usage })]);

  test("assembles content, reasoning, finish and usage at every byte split", async () => {
    const bytes = enc.encode(text).length;
    for (let cut = 1; cut < bytes; cut += 7) {
      const end = await readCompletionStream(body(text, [cut]), opts());
      expect(end.kind).toBe("complete");
      expect(end.response).toMatchObject({ content: "Héllo", reasoning: "think", finishReason: "stop", provider: "Inceptron", usage });
    }
  });

  test("accepts CRLF framing and comments", async () => {
    const crlf = (": OPENROUTER PROCESSING\r\n\r\n" + text).replaceAll("\n\n", "\r\n\r\n");
    expect((await readCompletionStream(body(crlf), opts())).kind).toBe("complete");
  });

  test("interleaved tool calls with identity after argument fragments", async () => {
    const t = sse([
      chunk({ tool_calls: [{ index: 1, function: { arguments: "{\"tr" } }] }),
      chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "get_clips", arguments: "{}" } }] }),
      chunk({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "get_mixer", arguments: "ack\":1}" } }] }),
      chunk({}, "tool_calls", { usage }),
    ]);
    const end = await readCompletionStream(body(t), opts());
    expect(releasedToolCalls(end)).toEqual([
      { id: "a", type: "function", function: { name: "get_clips", arguments: "{}" } },
      { id: "b", type: "function", function: { name: "get_mixer", arguments: "{\"track\":1}" } },
    ]);
  });

  test("conflicting identity is malformed", async () => {
    const t = sse([chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "x", arguments: "" } }] }),
      chunk({ tool_calls: [{ index: 0, id: "z" }] }), chunk({}, "tool_calls")]);
    expect(await readCompletionStream(body(t), opts())).toMatchObject({ kind: "failed", reason: "malformed" });
  });

  test("end of stream without a finish reason is truncated; usage still recorded", async () => {
    const t = sse([chunk({ content: "Hi" }), chunk({}, null, { usage })], "");
    expect(await readCompletionStream(body(t), opts())).toMatchObject({ kind: "failed", reason: "truncated", response: { usage } });
  });

  test("finish reason then clean end of stream without [DONE] is complete", async () => {
    expect((await readCompletionStream(body(sse([chunk({ content: "Hi" }, "stop")], "")), opts())).kind).toBe("complete");
  });

  test("an unterminated last event is truncated, even after a finish reason", async () => {
    const last = `data: ${JSON.stringify(chunk({}, "stop", { usage }))}`;
    for (const tail of ["", "\n"]) {
      const t = sse([chunk({ content: "Hi" }, "stop")], "") + last + tail;
      expect(await readCompletionStream(body(t), opts())).toMatchObject({ kind: "failed", reason: "truncated" });
    }
    const half = sse([chunk({ content: "Hi" }, "stop")], "") + last.slice(0, 40);
    expect(await readCompletionStream(body(half), opts())).toMatchObject({ kind: "failed", reason: "truncated" });
  });

  test("a terminated last event without [DONE] is complete with its usage", async () => {
    const t = sse([chunk({ content: "Hi" }, "stop"), chunk({}, "stop", { usage })], "");
    expect(await readCompletionStream(body(t), opts())).toMatchObject({ kind: "complete", response: { usage } });
  });

  test("an error event fails the stream", async () => {
    const t = sse([chunk({ content: "Hi" }), { error: { code: 502, message: "upstream" }, choices: [{ index: 0, delta: {}, finish_reason: "error" }] }]);
    expect(await readCompletionStream(body(t), opts())).toMatchObject({ kind: "failed", reason: "error" });
  });

  test("length withholds tool calls", async () => {
    const t = sse([chunk({ tool_calls: [{ index: 0, id: "a", type: "function", function: { name: "get_clips", arguments: "{" } }] }), chunk({}, "length")]);
    const end = await readCompletionStream(body(t), opts());
    expect(end.kind).toBe("complete");
    expect(end.response.toolCalls).toHaveLength(1);
    expect(releasedToolCalls(end)).toEqual([]);
  });

  test("a comments-only stream trips the first-data timeout", async () => {
    let n = 0;
    const comments = new ReadableStream<Uint8Array>({ async pull(ctl) {
      if (n++ > 50) { ctl.close(); return; }
      await new Promise((r) => setTimeout(r, 5)); ctl.enqueue(enc.encode(": keep-alive\n\n"));
    } });
    expect(await readCompletionStream(comments, opts({ firstDataBy: Date.now() + 40 }))).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  test("an idle gap trips the idle timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`)); } });
    expect(await readCompletionStream(stalled, opts({ idleMs: 30 }))).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  test("the deadline trips even while bytes keep arriving", async () => {
    let n = 0;
    const slow = new ReadableStream<Uint8Array>({ async pull(ctl) {
      if (n++ > 100) { ctl.close(); return; }
      await new Promise((r) => setTimeout(r, 5)); ctl.enqueue(enc.encode(`data: ${JSON.stringify(chunk({ content: "a" }))}\n\n`));
    } });
    expect(await readCompletionStream(slow, opts({ deadline: Date.now() + 40 }))).toMatchObject({ kind: "failed", reason: "timeout" });
  });

  test("a valid stream above 2 MiB is accepted; one above the wire limit is not", async () => {
    const many = sse([...Array.from({ length: 20_000 }, () => chunk({ content: "x" })), chunk({}, "stop", { usage })]);
    expect(enc.encode(many).length).toBeGreaterThan(2 * 1024 * 1024);
    expect((await readCompletionStream(body(many), opts())).kind).toBe("complete");
    const small = { ...STREAM_LIMITS, wireBytes: 1024 };
    expect(await readCompletionStream(body(many), opts({ limits: small }))).toMatchObject({ kind: "failed", reason: "limit" });
  });

  test("reports the first chunk id once", async () => {
    const ids: string[] = [];
    await readCompletionStream(body(text), opts({ onId: (id: string) => ids.push(id) }));
    expect(ids).toEqual(["gen-1"]);
  });
});
