import { invoke } from "@tauri-apps/api/core";
import { ChatMessage, Completion, ModelProvider, ToolRunner } from "../agent/loop";
import { AccountView, errorMessage } from "./account";

// The only ModelProvider implementation. Everything that makes the call a
// call -- prompt, tool schema and authenticated transport -- lives in Rust.
// Account state returns to the webview; the credential never does.
export function tauriProvider(onAccount: (view: AccountView) => void, captureEpoch: number | null = null): ModelProvider {
  return { async complete(messages: ChatMessage[], request): Promise<Completion> {
    try {
      const out = await invoke<{ text: string; tool_calls: Completion["toolCalls"]; account?: AccountView }>(
        "model_complete",
        { messages, turnId: request?.turnId, requestId: request?.requestId, round: request?.round, captureEpoch },
      );
      if (out.account) onAccount(out.account);
      return { text: out.text, toolCalls: out.tool_calls ?? [] };
    } catch (error) { throw new Error(errorMessage(error)); }
  } };
}

export const tauriTools: ToolRunner = {
  run: (name, args) => invoke("execute_tool", { name, args }),
};
