import { useState, type ReactNode } from "react";
import { SetState } from "../live/model";
import { ChatMessage, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, parseMarkdown } from "./markdown";
import { loadGoal, saveGoal, GOAL_MAX_LENGTH } from "./goal";

/**
 * Permanent and non-dismissible. Plan 1 could only display wrong data; from
 * here the app can state wrong things fluently, in prose, about the
 * producer's music. The probe and the fencing are defences and neither is
 * airtight -- this sets the relationship the rest of the design assumes.
 */
const DISCLAIMER = "AI can make mistakes. Treat responses as suggestions.";

// The chip that stands in for a «fenced» set-derived name (track names, in
// practice). Faint and muted on purpose -- it should read as "this text
// came from your project", not compete with the model's own words.
const FENCE_CHIP_STYLE = {
  background: "rgba(255,255,255,0.1)",
  color: "#aaa",
  padding: "0 4px",
  borderRadius: 3,
} as const;

const CODE_STYLE = { font: "12px ui-monospace, monospace", background: "rgba(255,255,255,0.08)", padding: "0 3px" };

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "bold":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "italic":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "code":
        return (
          <code key={i} style={CODE_STYLE}>
            {n.text}
          </code>
        );
      case "fence":
        return (
          <span key={i} style={FENCE_CHIP_STYLE}>
            {n.name}
          </span>
        );
    }
  });
}

// Rendered small on purpose: this is a narrow, always-on-top pane, not a
// document -- a heading here is an emphasised line, never large type.
function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "paragraph":
        return (
          <div key={i} style={{ whiteSpace: "pre-wrap" }}>
            {renderInline(b.children)}
          </div>
        );
      case "heading":
        return (
          <div key={i} style={{ fontWeight: "bold", opacity: 0.85 }}>
            {renderInline(b.children)}
          </div>
        );
      case "list":
        return b.ordered ? (
          <ol key={i} style={{ margin: "2px 0", paddingLeft: 20 }}>
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} style={{ margin: "2px 0", paddingLeft: 20 }}>
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ul>
        );
      case "code_block":
        return (
          <pre key={i} style={{ ...CODE_STYLE, padding: 6, overflowX: "auto" }}>
            {b.text}
          </pre>
        );
    }
  });
}

// Markdown is applied to the model's replies only -- the producer's own
// words render as plain text, same as before.
function MessageBody({ role, content }: { role: ChatMessage["role"]; content: string | null | undefined }) {
  if (role !== "assistant") return <>{content}</>;
  return <>{renderBlocks(parseMarkdown(content ?? ""))}</>;
}

export function Chat({ state }: { state: SetState }) {
  const [goal, setGoal] = useState(loadGoal);
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
        maxLength={GOAL_MAX_LENGTH}
        onChange={(e) => {
          setGoal(e.target.value);
          saveGoal(e.target.value);
        }}
      />
      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {history.map((m, i) => (
          <div key={i} style={{ marginBottom: 6, whiteSpace: "pre-wrap" }}>
            <b>{m.role === "user" ? "you" : "copilot"}</b>{" "}
            <MessageBody role={m.role} content={m.content} />
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
