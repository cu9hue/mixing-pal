// Mirrors src-tauri/src/model.rs's ChatMessage/ToolCall. This is the IPC
// contract as well as the loop's own vocabulary.
export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  // "system" is included so callers can check a history never contains one
  // (see loop.test.ts); the loop itself never constructs one -- the system
  // prompt is backend-owned (src-tauri/src/model.rs).
  role: "user" | "assistant" | "tool" | "system";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface Completion {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * The seam a second provider slots into later. There is one implementation
 * today (src/model/provider.ts, which calls Rust); the loop is tested
 * against a scripted stub, never against a network.
 *
 * No `system` or `tools` parameter by design: both are backend-owned, and a
 * parameter here would be a way for the webview to widen them.
 */
export interface ModelProvider {
  complete(messages: ChatMessage[]): Promise<Completion>;
}

export interface ToolRunner {
  run(name: string, args: unknown): Promise<unknown>;
}

/**
 * A model that keeps calling tools and never answers would otherwise spend
 * the producer's credit until they notice. Six is enough for the two tools
 * this cut ships plus a couple of follow-ups.
 */
export const MAX_ROUND_TRIPS = 6;

export async function runTurn(
  provider: ModelProvider,
  tools: ToolRunner,
  messages: ChatMessage[],
  onProgress?: (name: string, args: unknown) => void,
): Promise<{ messages: ChatMessage[]; text: string; truncated: boolean }> {
  const history = [...messages];

  for (let round = 0; round < MAX_ROUND_TRIPS; round++) {
    const completion = await provider.complete(history);
    if (completion.toolCalls.length === 0) {
      history.push({ role: "assistant", content: completion.text });
      return { messages: history, text: completion.text, truncated: false };
    }

    history.push({
      role: "assistant",
      content: completion.text === "" ? null : completion.text,
      tool_calls: completion.toolCalls,
    });

    // One tool message per call id, in order. A provider rejects the whole
    // next request if any id goes unanswered.
    for (const c of completion.toolCalls) {
      let args: unknown;
      try {
        args = JSON.parse(c.function.arguments || "{}");
      } catch {
        history.push({
          role: "tool",
          tool_call_id: c.id,
          content: JSON.stringify({
            value: null,
            missing_reason: "bad_arguments",
            fresh: false,
          }),
        });
        continue;
      }

      onProgress?.(c.function.name, args);
      let result: unknown;
      try {
        result = await tools.run(c.function.name, args);
      } catch (err) {
        result = {
          value: null,
          fresh: false,
          missing_reason: `tool_failed: ${String(err)}`,
        };
      }
      history.push({
        role: "tool",
        tool_call_id: c.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    messages: history,
    text:
      "I kept needing to look things up and ran out of steps before answering. " +
      "Try asking about one thing at a time.",
    truncated: true,
  };
}
