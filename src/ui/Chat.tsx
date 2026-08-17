import { useState } from "react";
import { SetState } from "../live/model";
import { ChatMessage, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";

/**
 * Permanent and non-dismissible. Plan 1 could only display wrong data; from
 * here the app can state wrong things fluently, in prose, about the
 * producer's music. The probe and the fencing are defences and neither is
 * airtight -- this sets the relationship the rest of the design assumes.
 */
const DISCLAIMER = "AI can make mistakes. Treat responses as suggestions.";

// The spec calls the goal field "a persistent free-text field" and
// "probably the highest leverage" thing in the design -- it must survive a
// webview reload, not just a re-render.
const GOAL_STORAGE_KEY = "copilot.goal";

// Reads the persisted goal. localStorage access can throw (e.g. a
// SecurityError in some webview storage configurations); catching here
// matters because this runs inside a useState initializer during render --
// an uncaught throw there would unmount the whole chat pane, not just lose
// the goal text. Do not remove this catch as unnecessary defensiveness.
function loadStoredGoal(): string {
  try {
    return localStorage.getItem(GOAL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Chat({ state }: { state: SetState }) {
  const [goal, setGoal] = useState(loadStoredGoal);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const question = input.trim();
    if (question === "" || busy) return;
    setInput("");
    setError(null);
    setBusy(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as it
    // was when the conversation started.
    const turn: ChatMessage[] = [
      ...history,
      { role: "user", content: `${buildContext(state, goal)}\n\n---\n\n${question}` },
    ];
    setHistory([...history, { role: "user", content: question }]);

    try {
      const out = await runTurn(tauriProvider, tauriTools, turn, (name, args) =>
        setProgress(`${name}(${JSON.stringify(args)})`),
      );
      setHistory((h) => [...h, { role: "assistant", content: out.text }]);
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      setError(String(e));
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: 10, borderTop: "1px solid #444" }}>
      <input
        placeholder="What are you working on? (genre, reference, today's goal)"
        value={goal}
        maxLength={500}
        onChange={(e) => {
          setGoal(e.target.value);
          // Losing persistence on a failed write is an acceptable
          // degradation; letting it throw out of an input handler and break
          // typing in the field is not. Do not remove this catch.
          try {
            localStorage.setItem(GOAL_STORAGE_KEY, e.target.value);
          } catch {
            // Best-effort only -- see comment above.
          }
        }}
      />
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {history.map((m, i) => (
          <div key={i} style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>
            <b>{m.role === "user" ? "you" : "copilot"}</b> {m.content}
          </div>
        ))}
        {progress && <div style={{ opacity: 0.6 }}>reading {progress}…</div>}
        {error && <div style={{ background: "#7a2020", color: "white", padding: 6 }}>{error}</div>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          style={{ flex: 1 }}
          value={input}
          placeholder="Ask about the set…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        <button onClick={send} disabled={busy}>
          {busy ? "…" : "Ask"}
        </button>
      </div>
      <div style={{ opacity: 0.55, fontSize: 11 }}>{DISCLAIMER}</div>
    </div>
  );
}
