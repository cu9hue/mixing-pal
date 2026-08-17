import { invoke } from "@tauri-apps/api/core";
import { ChatMessage, Completion, ModelProvider, ToolRunner } from "../agent/loop";

// The only ModelProvider implementation. Everything that makes the call a
// call -- base URL, model, key, system prompt, tool schema -- lives in Rust;
// this passes messages across and nothing else.
export const tauriProvider: ModelProvider = {
  async complete(messages: ChatMessage[]): Promise<Completion> {
    const out = await invoke<{ text: string; tool_calls: Completion["toolCalls"] }>(
      "model_complete",
      { messages },
    );
    return { text: out.text, toolCalls: out.tool_calls ?? [] };
  },
};

export const tauriTools: ToolRunner = {
  run: (name, args) => invoke("execute_tool", { name, args }),
};
