import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { SetState } from "../live/model";
import { ChatMessage, ToolRunner, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, parseMarkdown } from "./markdown";
import { progressLabel } from "./progressLabel";
import { waitingLabel } from "./waitingLabel";
import { Exchange, begin, complete, fail } from "./thread";
import { loadThread, saveThread } from "../model/threads";
import { SWITCH_HOLD_MS, ThreadKey, carryNote, classify, historyFrom, keyFor, recapLine } from "./threadStore";
import { Note, emptyNote, mergeNote, noteDelta } from "../notes/note";
import { SetRow } from "./SetRow";
import { EXAMPLE_QUESTIONS } from "./examples";

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
        <div className="card__answer selectable" data-tauri-drag-region="false">
          {renderBlocks(parseMarkdown(x.answer))}
        </div>
      )}
      {x.error !== null && (
        <div className="card__error selectable" data-tauri-drag-region="false">
          {x.error}
        </div>
      )}
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
  onGoalChange,
  onTurnRunningChange,
  onAnswer,
}: {
  state: SetState;
  goal: string;
  onGoalChange: (value: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
}) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  // Reads this turn, for the waiting line. Reset when a turn starts.
  const [toolsCalled, setToolsCalled] = useState(0);
  const [busy, setBusy] = useState(false);

  // The identity the thread on screen is filed under, and the line above
  // a thread that was restored. The thread follows the set: when the
  // mirror's identity changes to another set and holds, this loads that
  // set's thread, or an empty one, and every settled exchange is saved
  // under the key it was asked in. Questions asked before the first
  // identity arrives are carried into the first thread rather than lost.
  const [key, setKey] = useState<ThreadKey | null>(null);
  const [recap, setRecap] = useState<string | null>(null);
  const threadRef = useRef<Exchange[]>([]);
  threadRef.current = thread;
  // The set's note rides beside the thread: same key, same switch, same
  // file. The model's changes are merged deterministically after each
  // answer; hers arrive through the Notes row.
  const [note, setNote] = useState<Note>(emptyNote());
  const noteRef = useRef<Note>(emptyNote());
  noteRef.current = note;
  // A save that failed, shown above the thread until one succeeds. The
  // note is hers by hand; a write that silently failed would lose it with
  // the row still showing it applied.
  const [saveError, setSaveError] = useState<string | null>(null);
  const next = keyFor(state);
  const nextId = next?.id ?? null;
  const nextPath = next?.path ?? null;
  useEffect(() => {
    const target = nextId === null ? null : { id: nextId, path: nextPath };
    const action = classify(key, target, busy);
    if (action === "none" || target === null) return;
    if (action === "rekey") {
      // Same set, new name: the thread stays, the file follows. Saving
      // under the new key is what makes the Rust index adopt it.
      setKey(target);
      persist(target, threadRef.current, noteRef.current);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      if (cancelled) return;
      let saved: Awaited<ReturnType<typeof loadThread>>;
      try {
        saved = await loadThread(target);
      } catch (e) {
        // The file could not be read. Keep what is on screen rather than
        // start that set over on top of a thread nobody has seen; the
        // next identity change tries again.
        console.error("failed to load the set's thread", e);
        return;
      }
      if (cancelled) return;
      const restored = saved?.exchanges ?? [];
      const carried = key === null ? threadRef.current : [];
      const merged = [...restored, ...carried];
      const { note: restoredNote, carried: noteCarried } = carryNote(saved, noteRef.current, key === null);
      setNote(restoredNote);
      setKey(target);
      setThread(merged);
      setHistory(historyFrom(merged, MAX_HISTORY_MESSAGES));
      setRecap(
        saved !== null && restored.length > 0
          ? recapLine(restored.length, saved.saved_at, Math.floor(Date.now() / 1000))
          : null,
      );
      if (carried.length > 0 || noteCarried) persist(target, merged, restoredNote);
    }, SWITCH_HOLD_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, nextId, nextPath, busy]);

  function persist(under: ThreadKey | null, exchanges: Exchange[], withNote: Note) {
    if (under === null) return;
    saveThread(under, exchanges, withNote).then(
      () => setSaveError(null),
      (e) => {
        console.error("failed to save the thread", e);
        setSaveError(`Could not save this set's thread and notes: ${String(e)}`);
      },
    );
  }

  function changeNote(next: Note) {
    setNote(next);
    persist(key, threadRef.current, next);
  }

  // The newest question goes to the top of the body, which is where the
  // card has always put the question she is about to read the answer to.
  // Sending always scrolls. A fresh question has nothing below it yet, so
  // it may stop short of the top; the answer arriving scrolls again to
  // finish the job, but only while she is still at the bottom. Scrolling
  // up to an older answer unpins her, and nothing then pulls her away.
  const newest = useRef<HTMLDivElement>(null);
  // So an example question can hand her the caret along with the words.
  const inputRef = useRef<HTMLInputElement>(null);
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
    // Saved under the key current when the question was asked. A switch
    // waits for the turn, so this is the key the answer lands under too.
    const askedUnder = key;
    const begun = begin(threadRef.current, asked);
    setThread(begun);
    // Saved now, not only when the answer lands: a quit mid-turn keeps the
    // question, and the restored thread shows it with no answer.
    persist(askedUnder, begun, noteRef.current);
    startedAt.current = Date.now();
    setElapsedMs(0);
    setBusy(true);
    setToolsCalled(0);
    onTurnRunningChange(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as
    // it was when the conversation started.
    const turn: ChatMessage[] = [
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: "user", content: `${buildContext(state, goal, note.bullets)}\n\n---\n\n${asked}` },
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

      const out = await runTurn(tauriProvider, tracked, turn, (name, args) => {
        setToolsCalled((n) => n + 1);
        setProgress(progressLabel(name, args, state));
      });
      // The model's note changes ride at the end of its answer and are not
      // part of what she reads or what the history keeps.
      const { answer, delta } = noteDelta(out.text);
      const mergedNote = mergeNote(noteRef.current, delta, Math.floor(Date.now() / 1000));
      setNote(mergedNote);
      setHistory((h) => [
        ...h,
        { role: "assistant" as const, content: answer },
      ].slice(-MAX_HISTORY_MESSAGES));
      const settled = complete(threadRef.current, answer);
      setThread(settled);
      persist(askedUnder, settled, mergedNote);
      onAnswer();
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      const settled = fail(threadRef.current, String(e));
      setThread(settled);
      persist(askedUnder, settled, noteRef.current);
    } finally {
      setProgress(null);
      setBusy(false);
      onTurnRunningChange(false);
    }
  }

  const waiting = waitingLabel({ busy, toolProgress: progress, toolsCalled, elapsedMs });

  return (
    <>
      {/* The set's row lives here, not in Card, because the note is this
          component's state. Keyed on the thread key so a half-typed edit
          cannot land in another set. */}
      <SetRow
        key={key === null ? "" : `${key.id ?? ""}:${key.path ?? ""}`}
        goal={goal}
        onGoalChange={onGoalChange}
        note={note}
        onNoteChange={changeNote}
      />
      <div
        className="card__body"
        data-tauri-drag-region="false"
        onScroll={(e) => {
          const b = e.currentTarget;
          pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight <= 1;
        }}
      >
        {saveError !== null && (
          <div className="card__error selectable" data-tauri-drag-region="false">
            {saveError}
          </div>
        )}
        {recap !== null && <div className="card__recap">{recap}</div>}
        {/* First launch, and any set with no thread yet: a header, a goal,
            and an input said nothing about what this thing answers. The
            examples are questions it can, phrased the way she would. */}
        {thread.length === 0 && recap === null && waiting === null && (
          <div className="card__empty">
            <div className="card__empty-line">Ask about the set you have open. For example:</div>
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                className="card__example"
                onClick={() => {
                  setInput(q);
                  inputRef.current?.focus();
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {thread.map((x, i) => (
          <div
            key={i}
            className="card__exchange"
            data-tauri-drag-region="deep"
            ref={i === thread.length - 1 ? newest : undefined}
          >
            <ExchangeView x={x} />
          </div>
        ))}
        {waiting !== null && (
          <div
            className={`card__progress${progress === null ? " card__progress--thinking" : ""}`}
            data-tauri-drag-region="deep"
          >
            {waiting}
          </div>
        )}
      </div>
      <div className="card__footer">
        <input
          ref={inputRef}
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
