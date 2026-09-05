import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { SetState } from "../live/model";
import { ChatMessage, ToolRunner, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, parseMarkdown } from "./markdown";
import { progressLabel } from "./progressLabel";
import { waitingLabel } from "./waitingLabel";
import { Exchange, begin, complete, fail } from "./thread";

const MAX_HISTORY_MESSAGES = 12;

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
      // Cells wrap first; past a floor per cell the wrapper scrolls sideways
      // instead, so a wide table never breaks the card's width.
      case "table":
        return (
          <div key={i} className="card__table-wrap">
            <table className="card__table">
              <thead>
                <tr>
                  {b.header.map((cell, j) => (
                    <th key={j}>{renderInline(cell)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {row.map((cell, j) => (
                      <td key={j}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

// Memoised because the component below re-renders once a second while a
// turn runs, and an Exchange never changes once settled: without this every
// tick would reparse every answer of the session.
const ExchangeView = memo(function ExchangeView({ x }: { x: Exchange }) {
  return (
    <>
      <div className="card__question">{x.question}</div>
      {x.answer !== null && (
        <div className="card__answer selectable">{renderBlocks(parseMarkdown(x.answer))}</div>
      )}
      {x.error !== null && <div className="card__error selectable">{x.error}</div>}
    </>
  );
});

/**
 * The whole session is on screen, newest exchange last. She reads the
 * thread; the model is sent `history`, a short recent window. The two are
 * different budgets and neither one caps the other.
 */
export function Conversation({
  state,
  goal,
  onTurnRunningChange,
  onAnswer,
}: {
  state: SetState;
  goal: string;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
}) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The newest question goes to the top of the body, which is where the
  // card has always put the question she is about to read the answer to.
  // Sending always scrolls. A fresh question has nothing below it yet, so
  // it may stop short of the top; the answer arriving scrolls again to
  // finish the job, but only while she is still at the bottom. Scrolling
  // up to an older answer unpins her, and nothing then pulls her away.
  const newest = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (pinned.current) newest.current?.scrollIntoView({ block: "start" });
  }, [thread]);

  // When the current turn started, and a clock to re-read it against. The
  // elapsed figure only appears once a turn is slow, but nothing else
  // re-renders this component while it waits -- without the interval the
  // label would freeze at whatever it said when the turn began.
  const startedAt = useRef(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt.current), 1000);
    return () => clearInterval(id);
  }, [busy]);

  async function send() {
    const asked = input.trim();
    if (asked === "" || busy) return;
    setInput("");
    pinned.current = true;
    setThread((t) => begin(t, asked));
    startedAt.current = Date.now();
    setElapsedMs(0);
    setBusy(true);
    onTurnRunningChange(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as
    // it was when the conversation started.
    const turn: ChatMessage[] = [
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: "user", content: `${buildContext(state, goal)}\n\n---\n\n${asked}` },
    ];
    setHistory((h) => [
      ...h,
      { role: "user" as const, content: asked },
    ].slice(-MAX_HISTORY_MESSAGES));

    try {
      // runTurn reports a tool BEFORE it runs and has no "finished" signal,
      // so the last tool's line used to linger over the whole final stretch
      // while the model wrote prose -- the card claiming to read a track it
      // had stopped reading. Clearing it here, rather than widening
      // runTurn's callback, keeps agent/loop.ts and its tests untouched.
      const tracked: ToolRunner = {
        run: async (name, args) => {
          try {
            return await tauriTools.run(name, args);
          } finally {
            setProgress(null);
          }
        },
      };

      const out = await runTurn(tauriProvider, tracked, turn, (name, args) =>
        setProgress(progressLabel(name, args, state)),
      );
      setHistory((h) => [
        ...h,
        { role: "assistant" as const, content: out.text },
      ].slice(-MAX_HISTORY_MESSAGES));
      setThread((t) => complete(t, out.text));
      onAnswer();
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      setThread((t) => fail(t, String(e)));
    } finally {
      setProgress(null);
      setBusy(false);
      onTurnRunningChange(false);
    }
  }

  const waiting = waitingLabel({ busy, toolProgress: progress, elapsedMs });

  return (
    <>
      <div
        className="card__body"
        onScroll={(e) => {
          const b = e.currentTarget;
          pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight <= 1;
        }}
      >
        {thread.map((x, i) => (
          <div
            key={i}
            className="card__exchange"
            ref={i === thread.length - 1 ? newest : undefined}
          >
            <ExchangeView x={x} />
          </div>
        ))}
        {waiting !== null && (
          <div
            className={`card__progress${progress === null ? " card__progress--thinking" : ""}`}
          >
            {waiting}
          </div>
        )}
      </div>
      <div className="card__footer">
        <input
          className="card__input"
          value={input}
          placeholder="Ask about the set…"
          onChange={(e) => setInput(e.target.value)}
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
