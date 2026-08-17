import { describe, expect, it, vi } from "vitest";
import {
  ChatMessage,
  Completion,
  MAX_ROUND_TRIPS,
  ModelProvider,
  runTurn,
  ToolRunner,
} from "./loop";

function scriptedProvider(script: Completion[]): ModelProvider & { seen: ChatMessage[][] } {
  const seen: ChatMessage[][] = [];
  let i = 0;
  return {
    seen,
    async complete(messages) {
      seen.push([...messages]);
      return script[Math.min(i++, script.length - 1)];
    },
  };
}

const call = (id: string, name: string, args: string) => ({
  id,
  type: "function",
  function: { name, arguments: args },
});

const echoTools: ToolRunner = { run: async (name, args) => ({ name, args }) };

describe("runTurn", () => {
  it("ends in one round trip when the model asks for no tools", async () => {
    const provider = scriptedProvider([{ text: "Your kick sits at -3 dB.", toolCalls: [] }]);
    const out = await runTurn(provider, echoTools, [
      { role: "user", content: "how loud is the kick?" },
    ]);
    expect(out.text).toBe("Your kick sits at -3 dB.");
    expect(out.truncated).toBe(false);
    expect(provider.seen).toHaveLength(1);
  });

  it("gives every tool call exactly one tool message, keyed by its id", async () => {
    // A provider rejects the whole request if a tool_calls message is not
    // answered by one tool message per id. Getting this wrong shows up as a
    // 400 on the NEXT turn, far from the cause.
    const provider = scriptedProvider([
      {
        text: "",
        toolCalls: [
          call("a", "get_track_detail", '{"track":0}'),
          call("b", "get_track_detail", '{"track":1}'),
        ],
      },
      { text: "done", toolCalls: [] },
    ]);
    const out = await runTurn(provider, echoTools, [{ role: "user", content: "compare them" }]);

    const toolMessages = out.messages.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
    const assistant = out.messages.find((m) => m.role === "assistant");
    expect(assistant?.tool_calls).toHaveLength(2);
    expect(out.text).toBe("done");
  });

  it("stops at the round-trip cap instead of looping forever", async () => {
    // A model that keeps calling tools and never answers would otherwise
    // burn the producer's credit indefinitely.
    const provider = scriptedProvider([
      { text: "", toolCalls: [call("a", "get_track_detail", '{"track":0}')] },
    ]);
    const out = await runTurn(provider, echoTools, [{ role: "user", content: "hi" }]);
    expect(out.truncated).toBe(true);
    expect(provider.seen.length).toBe(MAX_ROUND_TRIPS);
  });

  it("reports unparseable arguments to the model rather than throwing", async () => {
    const provider = scriptedProvider([
      { text: "", toolCalls: [call("a", "get_track_detail", "not json")] },
      { text: "recovered", toolCalls: [] },
    ]);
    const out = await runTurn(provider, echoTools, [{ role: "user", content: "hi" }]);
    const toolMessage = out.messages.find((m) => m.role === "tool");
    expect(toolMessage?.content).toContain("bad_arguments");
    expect(out.text).toBe("recovered");
  });

  it("reports a tool that throws rather than failing the whole turn", async () => {
    const provider = scriptedProvider([
      { text: "", toolCalls: [call("a", "get_clip_notes", '{"track":0,"clip":0}')] },
      { text: "recovered", toolCalls: [] },
    ]);
    const throwing: ToolRunner = {
      run: async () => {
        throw new Error("ipc died");
      },
    };
    const out = await runTurn(provider, throwing, [{ role: "user", content: "hi" }]);
    expect(out.messages.find((m) => m.role === "tool")?.content).toContain("tool_failed");
    expect(out.text).toBe("recovered");
  });

  it("reports progress before each tool runs, so the wait is legible", async () => {
    const provider = scriptedProvider([
      { text: "", toolCalls: [call("a", "get_clip_notes", '{"track":3,"clip":0}')] },
      { text: "done", toolCalls: [] },
    ]);
    const onProgress = vi.fn();
    await runTurn(provider, echoTools, [{ role: "user", content: "hi" }], onProgress);
    expect(onProgress).toHaveBeenCalledWith("get_clip_notes", { track: 3, clip: 0 });
  });

  it("never sends a system message; the backend owns that", async () => {
    const provider = scriptedProvider([{ text: "ok", toolCalls: [] }]);
    await runTurn(provider, echoTools, [{ role: "user", content: "hi" }]);
    expect(provider.seen[0].some((m) => m.role === "system")).toBe(false);
  });
});
