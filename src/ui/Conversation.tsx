import { useState, type ReactNode } from "react";
import { SetState } from "../live/model";
import { ChatMessage, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, parseMarkdown } from "./markdown";
import { progressLabel } from "./progressLabel";

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
          <code key={i} className="card__code">
            {n.text}
          </code>
        );
      // A name that came from her project, not from the model. Faint and
      // muted on purpose -- it should read as "this is yours", not compete
      // with the model's own words.
      case "fence":
        return (
          <span key={i} className="card__fence">
            {n.name}
          </span>
        );
    }
  });
}

function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "paragraph":
        return (
          <p key={i} className="card__paragraph">
            {renderInline(b.children)}
          </p>
        );
      // Rendered as an emphasised line, never large type: this is a narrow
      // always-on-top pane, not a document.
      case "heading":
        return (
          <div key={i} className="card__subhead">
            {renderInline(b.children)}
          </div>
        );
      case "list":
        return b.ordered ? (
          <ol key={i} className="card__list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="card__list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ul>
        );
      case "code_block":
        return (
          <pre key={i} className="card__code-block">
            {b.text}
          </pre>
        );
    }
  });
}

/**
 * Reading model 2: only the current exchange is on screen.
 *
 * `history` still holds the whole conversation and the whole thing goes to
 * the model on every turn -- that is a separate concern from what she
 * looks at. The session reader that surfaces the rest is a later plan.
 */
export function Conversation({
  state,
  goal,
  onTurnRunningChange,
  onAnswer,
  onInputEmptyChange,
}: {
  state: SetState;
  goal: string;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onInputEmptyChange: (empty: boolean) => void;
}) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const asked = input.trim();
    if (asked === "" || busy) return;
    setInput("");
    onInputEmptyChange(true);
    setError(null);
    setAnswer(null);
    setQuestion(asked);
    setBusy(true);
    onTurnRunningChange(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as
    // it was when the conversation started.
    const turn: ChatMessage[] = [
      ...history,
      { role: "user", content: `${buildContext(state, goal)}\n\n---\n\n${asked}` },
    ];
    setHistory([...history, { role: "user", content: asked }]);

    try {
      const out = await runTurn(tauriProvider, tauriTools, turn, (name, args) =>
        setProgress(progressLabel(name, args, state)),
      );
      setHistory((h) => [...h, { role: "assistant", content: out.text }]);
      setAnswer(out.text);
      onAnswer();
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      setError(String(e));
    } finally {
      setProgress(null);
      setBusy(false);
      onTurnRunningChange(false);
    }
  }

  return (
    <>
      <div className="card__body">
        {question !== null && <div className="card__question">{question}</div>}
        {answer !== null && (
          <div className="card__answer selectable">{renderBlocks(parseMarkdown(answer))}</div>
        )}
        {progress !== null && <div className="card__progress">{progress}</div>}
        {error !== null && <div className="card__error selectable">{error}</div>}
      </div>
      <div className="card__footer">
        <input
          className="card__input"
          value={input}
          placeholder="Ask about the set…"
          onChange={(e) => {
            setInput(e.target.value);
            onInputEmptyChange(e.target.value.trim() === "");
          }}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        {/* Permanent and non-dismissible. From here the app can state wrong
            things fluently, in prose, about her music, and it cannot hear
            any of it. */}
        <div className="card__disclaimer">AI can make mistakes. Treat responses as suggestions.</div>
      </div>
    </>
  );
}
