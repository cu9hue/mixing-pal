// Mirrors src-tauri/src/model.rs's ChatMessage/ToolCall. This is the IPC
// contract as well as the loop's own vocabulary.
export interface ToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  // Deliberately narrow: no TypeScript in this codebase, present or future,
  // can construct a system message. The system prompt is backend-owned
  // (src-tauri/src/model.rs); Rust also refuses one at the wire boundary,
  // but that is a runtime check. This is a compile-time guarantee, so it is
  // worth keeping even though it means the "we never send one" test
  // (loop.test.ts) has to assert an unrepresentable property with a cast.
  role: "user" | "assistant" | "tool";
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
 * the producer's credit until they notice. There are eight tools now, and
 * the prompt routinely chains a whole-set call into a couple of narrower
 * ones -- get_device_chains into get_device_params or get_rack_contents,
 * get_clips into get_clip_notes, and now get_arrangement into
 * get_arrangement_notes, a second two-step drill-down. Six round trips is
 * still believed enough to cover one such chain plus a follow-up.
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
            queried_at: Date.now(),
            fresh_as_of: null,
            fresh: false,
            missing_reason: "bad_arguments",
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
          queried_at: Date.now(),
          fresh_as_of: null,
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
