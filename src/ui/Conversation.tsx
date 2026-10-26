import { ReportTarget } from "../model/reports";
import { useBusyState, beginMutation } from "../model/updates";
import { wireReady } from "../setup/step";
import wireVersion from "../../shared/wire-version.json";
import { Fragment, memo, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AccountState, canAsk, errorMessage } from "../model/account";
import { checkinTarget } from "./checkin";
import { MoveBox } from "./MoveBox";
import { MoveCheckin } from "./MoveCheckin";
import { AnswerMenu } from "./AnswerMenu";
import { SetState } from "../live/model";
import { ChatMessage, ToolRunner, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, markTerms, parseMarkdown } from "./markdown";
import { Read, readingLog } from "./readingLog";
import { waitingLabel } from "./waitingLabel";
import { Exchange, begin, complete, fail } from "./thread";
import { loadThread, saveThread } from "../model/threads";
import { SWITCH_HOLD_MS, ThreadKey, carryNote, classify, historyFrom, keyFor, recapLine } from "./threadStore";
import { Note, emptyNote, mergeNote, noteDelta } from "../notes/note";
import { moveLabel } from "../notes/move";
import { Term, termsList } from "../notes/terms";
import { Outcome, withTrackRead } from "../notes/outcomes";
import { SetRow } from "./SetRow";
import { starterQuestions } from "./examples";
import { GOAL_MAX_LENGTH } from "./goal";
import { WhatICanSee } from "./WhatICanSee";
import { Recap, recapFor } from "./recap";
import { RecapView } from "./RecapView";

const MAX_HISTORY_MESSAGES = 12;

/** What a tappable term needs from the answer that holds it. */
interface TermControls {
  open: number | null;
  toggle: (index: number) => void;
  lineId: (index: number) => string;
}

function renderInline(nodes: InlineNode[], terms?: TermControls): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "bold":
        return <strong key={i}>{renderInline(n.children, terms)}</strong>;
      case "italic":
        return <em key={i}>{renderInline(n.children, terms)}</em>;
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
      // A word she can tap for one plain line under its block. A button, so
      // Enter and Space work and a screen reader hears it can open.
      case "term":
        return terms === undefined ? n.text : (
          <button key={i} type="button" className="card__term" aria-expanded={terms.open === n.index}
            aria-controls={terms.lineId(n.index)} onClick={() => terms.toggle(n.index)}>
            {n.text}
          </button>
        );
    }
  });
}

/** The indexes of the terms marked anywhere in one block. */
function termsIn(block: BlockNode): number[] {
  const walk = (nodes: InlineNode[]): number[] => nodes.flatMap((n) =>
    n.type === "term" ? [n.index] : n.type === "bold" || n.type === "italic" ? walk(n.children) : []);
  switch (block.type) {
    case "paragraph":
    case "heading":
      return walk(block.children);
    case "list":
      return block.items.flatMap(walk);
    case "table":
      return [...block.header, ...block.rows.flat()].flatMap(walk);
    case "code_block":
      return [];
  }
}

/**
 * The answer's blocks. With terms, the open term's line sits directly under
 * the block that holds it, inside the card: the card clips anything that
 * floats, and the window is sized to the card.
 */
function renderBlocks(blocks: BlockNode[], terms?: TermControls & { list: Term[] }): ReactNode {
  return blocks.map((b, i) => {
    const open = terms?.open ?? null;
    const term = open !== null && termsIn(b).includes(open) ? terms!.list[open] : undefined;
    // Always a Fragment, so opening a line never remounts the block and the
    // tapped button keeps focus.
    return (
      <Fragment key={i}>
        {renderBlock(b, i, terms)}
        {term !== undefined && (
          <p id={terms!.lineId(open!)} role="note" className="card__term-line">
            <strong>{term.term}</strong>: {term.meaning}
          </p>
        )}
      </Fragment>
    );
  });
}

function renderBlock(b: BlockNode, i: number, terms?: TermControls): ReactNode {
  switch (b.type) {
    case "paragraph":
      return (
        <p key={i} className="card__paragraph">
          {renderInline(b.children, terms)}
        </p>
      );
    // Rendered as an emphasised line, never large type: this is a narrow
    // always-on-top pane, not a document.
    case "heading":
      return (
        <div key={i} className="card__subhead">
          {renderInline(b.children, terms)}
        </div>
      );
    case "list":
      return b.ordered ? (
        <ol key={i} className="card__list">
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item, terms)}</li>
          ))}
        </ol>
      ) : (
        <ul key={i} className="card__list">
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item, terms)}</li>
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
                  <th key={j}>{renderInline(cell, terms)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, j) => (
                    <td key={j}>{renderInline(cell, terms)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

// Memoised because the component below re-renders once a second while a
// turn runs, and an Exchange never changes once settled: without this every
// tick would reparse every answer of the session.
const ExchangeView = memo(function ExchangeView({ x }: { x: Exchange }) {
  // One open term per answer. Esc or a second tap on it closes the line.
  const [open, setOpen] = useState<number | null>(null);
  const id = useId();
  const terms = x.terms?.length ? {
    list: x.terms,
    open,
    toggle: (index: number) => setOpen((current) => (current === index ? null : index)),
    lineId: (index: number) => `${id}-term-${index}`,
  } : undefined;
  return (
    <>
      {x.answer !== null && (
        <div className="card__answer selectable" data-tauri-drag-region="false"
          onKeyDown={terms && ((e) => { if (e.key === "Escape" && open !== null) setOpen(null); })}>
          {terms ? renderBlocks(markTerms(parseMarkdown(x.answer), terms.list), terms) : renderBlocks(parseMarkdown(x.answer))}
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
  onTurnRunningChange,
  onAnswer,
  onReport,
  account,
  connected,
}: {
  connected: boolean;
  state: SetState;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onReport?: (target: ReportTarget) => void;
  account: AccountState;
}) {
  const operations = useBusyState();
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [thread, setThread] = useState<Exchange[]>([]);
  const [input, setInput] = useState("");
  const [goal, setGoal] = useState<string | null>(null);
  const goalRef = useRef<string | null>(null);
  goalRef.current = goal;
  const [goalDraft, setGoalDraft] = useState("");
  // Reads this turn, for the log and the waiting line. Reset when a turn starts.
  const [reads, setReads] = useState<Read[]>([]);
  const [busy, setBusy] = useState(false);

  // The identity the thread on screen is filed under, and the line above
  // a thread that was restored. The thread follows the set: when the
  // mirror's identity changes to another set and holds, this loads that
  // set's thread, or an empty one, and every settled exchange is saved
  // under the key it was asked in. Questions asked before the first
  // identity arrives are carried into the first thread rather than lost.
  const [key, setKey] = useState<ThreadKey | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;
  const [recap, setRecap] = useState<string | null>(null);
  // After a break, what she did last time stands in for the restored
  // exchanges, which stay folded until she asks for them.
  const [lastTime, setLastTime] = useState<Recap | null>(null);
  const [folded, setFolded] = useState(0);
  const threadRef = useRef<Exchange[]>([]);
  threadRef.current = thread;
  // The set's note rides beside the thread: same key, same switch, same
  // file. The model's changes are merged deterministically after each
  // answer; hers arrive through the Notes row.
  const [note, setNote] = useState<Note>(emptyNote());
  const noteRef = useRef<Note>(emptyNote());
  noteRef.current = note;
  // The set's outcome log rides beside the note: same key, same file. The
  // ref lets a load assign it before the save that follows in the same tick.
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const outcomesRef = useRef<Outcome[]>([]);
  outcomesRef.current = outcomes;
  // The check-in is opened by her coming back, not by the answer landing.
  // Its turn is fixed once open, so rating it does not close it before the heard step.
  const [checkin, setCheckin] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const dismissed = useRef<Set<string>>(new Set());
  const target = checkinTarget(thread, outcomes, dismissed.current, busy);
  const offerCheckin = useRef<() => void>(() => {});
  // Not while she is already editing that move from its menu: one set of choices at a time.
  offerCheckin.current = () => { if (target?.turnId && editing !== target.turnId) setCheckin(target.turnId); };
  useEffect(() => {
    const onFocus = () => offerCheckin.current();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  function closeCheckin() {
    if (checkin !== null) dismissed.current.add(checkin);
    setCheckin(null);
  }
  // A save that failed, shown above the thread until one succeeds. The
  // note is hers by hand; a write that silently failed would lose it with
  // the row still showing it applied.
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
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
      const previous = key;
      keyRef.current = target;
      setKey(target);
      persist(target, threadRef.current, noteRef.current, goalRef.current, previous);
      return;
    }
    setLoadError(null);
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
        setLoadError(`Could not load this set's conversation: ${String(e)}`);
        return;
      }
      if (cancelled) return;
      const restored = saved?.exchanges ?? [];
      const carried = key === null ? threadRef.current : [];
      const merged = [...restored, ...carried];
      const { note: restoredNote, carried: noteCarried } = carryNote(saved, noteRef.current, key === null);
      const carriedOutcomes = key === null ? outcomesRef.current : [];
      const restoredOutcomes = [...(saved?.outcomes ?? []), ...carriedOutcomes];
      setOutcomes(restoredOutcomes);
      outcomesRef.current = restoredOutcomes;
      setNote(restoredNote);
      const restoredGoal = saved?.goal ?? null;
      setGoal(restoredGoal);
      goalRef.current = restoredGoal;
      setGoalDraft("");
      keyRef.current = target;
      setKey(target);
      setThread(merged);
      // Another set's check-in or editor must not come back with this one.
      setCheckin(null);
      setEditing(null);
      setHistory(historyFrom(merged, MAX_HISTORY_MESSAGES));
      const now = Math.floor(Date.now() / 1000);
      const back = saved === null ? null : recapFor(restored, restoredOutcomes, restoredNote, saved.saved_at, now);
      setLastTime(back);
      setFolded(back === null ? 0 : restored.length);
      setRecap(saved !== null && restored.length > 0 && back === null ? recapLine(restored.length, saved.saved_at, now) : null);
      if (carried.length > 0 || noteCarried || carriedOutcomes.length > 0) persist(target, merged, restoredNote, restoredGoal);
    }, SWITCH_HOLD_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, nextId, nextPath, busy]);

  function persist(under: ThreadKey | null, exchanges: Exchange[], withNote: Note, withGoal = goalRef.current, rekeyFrom: ThreadKey | null = null) {
    if (under === null) return;
    saveThread(under, exchanges, withNote, outcomesRef.current, withGoal, rekeyFrom).then(
      () => setSaveError(null),
      (e) => {
        console.error("failed to save the thread", e);
        setSaveError(`Could not save this set's thread and notes: ${String(e)}`);
      },
    );
  }

  function changeNote(next: Note): boolean {
    if (operations.install) {
      setSaveError("Wait for the app update to finish before changing notes.");
      return false;
    }
    setNote(next);
    persist(key, threadRef.current, next);
    return true;
  }

  function changeOutcomes(next: Outcome[], under: ThreadKey | null): boolean {
    if (operations.install) return false;
    // A rating made on one set must not land in the set switched to since.
    if (keyRef.current?.id !== under?.id || keyRef.current?.path !== under?.path) return false;
    setOutcomes(next);
    outcomesRef.current = next;
    persist(under, threadRef.current, noteRef.current);
    return true;
  }

  function changeGoal(next: string) {
    if (operations.install) return;
    setGoal(next);
    goalRef.current = next;
    persist(key, threadRef.current, noteRef.current, next);
  }

  function finishGoal(next: string) {
    changeGoal(next);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  // Scroll only the answer area; scrolling ancestors can hide the controls.
  const newest = useRef<HTMLDivElement>(null);
  const scrollBody = useRef<HTMLDivElement>(null);
  // So an example question can hand her the caret along with the words.
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    const body = scrollBody.current;
    const exchange = newest.current;
    if (pinned.current && body && exchange) {
      body.scrollTop += exchange.getBoundingClientRect().top - body.getBoundingClientRect().top;
    }
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
    if (asked === "" || busy || goal === null || key === null || !canAsk(account.view)) return;
    if (!wireReady(connected, state.scriptVersion, wireVersion.version) || !beginMutation(operations, "turn")) return;
    setInput("");
    closeCheckin();
    pinned.current = true;
    // Saved under the key current when the question was asked. A switch
    // waits for the turn, so this is the key the answer lands under too.
    const askedUnder = key;
    const turnId = crypto.randomUUID();
    const captureEpoch = account.view?.capture ? account.view.consent_epoch ?? null : null;
    const begun = begin(threadRef.current, asked, turnId, account.view?.id);
    setThread(begun);
    // Saved now, not only when the answer lands: a quit mid-turn keeps the
    // question, and the restored thread shows it with no answer.
    persist(askedUnder, begun, noteRef.current);
    startedAt.current = Date.now();
    setElapsedMs(0);
    setBusy(true);
    setReads([]);
    onTurnRunningChange(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as
    // it was when the conversation started.
    const turn: ChatMessage[] = [
      ...history.slice(-MAX_HISTORY_MESSAGES),
      { role: "user", content: `${buildContext(state, goal, note.bullets, outcomes)}\n\n---\n\n${asked}` },
    ];
    setHistory((h) => [
      ...h,
      { role: "user" as const, content: asked },
    ].slice(-MAX_HISTORY_MESSAGES));

    try {
      // runTurn reports a tool BEFORE it runs and has no "finished" signal,
      // so a read would stay "in progress" over the whole final stretch while
      // the model wrote prose -- the card claiming to read a track it had
      // stopped reading. Marking it done here, rather than widening
      // runTurn's callback, keeps agent/loop.ts and its tests untouched.
      // runTurn hands the same args object to both, and runs a round's tools
      // in parallel, so that object tells the reads apart.
      const tracked: ToolRunner = {
        run: async (name, args, context) => {
          try {
            return await tauriTools.run(name, args, context);
          } finally {
            setReads((all) => all.map((r) => (r.args === args ? { ...r, done: true } : r)));
          }
        },
      };

      let tracksRead: string[] = [];
      const out = await runTurn(tauriProvider(account.observe(), captureEpoch), tracked, turn, (name, args) => {
        tracksRead = withTrackRead(tracksRead, args, state);
        setReads((all) => [...all, { name, args, done: false }]);
      }, { turnId, record: (event) => invoke("turn_event", { turnId, event }) });
      // The model's note changes, move label, and terms ride at the end of its
      // answer and are not part of what she reads or what the history keeps.
      const { answer, delta } = noteDelta(out.text);
      const { answer: moved, move } = moveLabel(answer);
      const { answer: shown, terms } = termsList(moved);
      const mergedNote = mergeNote(noteRef.current, delta, Math.floor(Date.now() / 1000));
      setNote(mergedNote);
      setHistory((h) => [
        ...h,
        { role: "assistant" as const, content: shown },
      ].slice(-MAX_HISTORY_MESSAGES));
      const settled = complete(threadRef.current, shown, {
        tracksRead, ...(move === null ? {} : { move }), ...(terms.length === 0 ? {} : { terms }),
      });
      setThread(settled);
      persist(askedUnder, settled, mergedNote);
      onAnswer();
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      const settled = fail(threadRef.current, errorMessage(e));
      setThread(settled);
      persist(askedUnder, settled, noteRef.current);
    } finally {
      setBusy(false);
      operations.turn = false;
      onTurnRunningChange(false);
      void account.refresh();
    }
  }

  // The log names what is being read, so the waiting line under it only has
  // to show the turn is alive and how long it has run.
  const waiting = waitingLabel({ busy, toolsCalled: reads.length, elapsedMs });
  const log = busy ? readingLog(reads, state) : [];
  const reading = reads.some((r) => !r.done);
  const accessProblem = canAsk(account.view) ? null
    : account.view?.access !== "active" ? "Check your account access in Settings."
    : account.view.service_paused ? "Model access is temporarily paused."
    : (account.view.reserved_micro_usd ?? 0) > 0 ? "Checking the last request’s usage. Please wait."
    : "Your remaining allowance cannot cover another request. See Settings.";
  const loadingSet = key === null || (next !== null && classify(key, next, busy) === "switch");

  if (loadingSet) return <div className="card__body" role={loadError === null ? "status" : "alert"}>
    {loadError ?? (next === null
      ? "Waiting for Live to identify this set. If this persists, save the set in Live."
      : "Opening this set…")}
  </div>;

  if (goal === null) return (
    <div className="set-row card__session-goal">
      <form onSubmit={(event) => { event.preventDefault(); finishGoal(goalDraft.trim()); }}>
        <h2>What are you making?</h2>
        <p>A goal helps tailor advice for this Live set. Change it anytime.</p>
        <label htmlFor="session-goal" className="card__label card__session-goal-label">Goal (optional)</label>
        <input id="session-goal" className="card__input" value={goalDraft}
          maxLength={GOAL_MAX_LENGTH}
          placeholder="e.g. dark garage, 2am"
          onChange={(event) => setGoalDraft(event.target.value)} />
        <div className="card__session-goal-actions">
          <button type="submit">Start chatting</button>
        </div>
      </form>
    </div>
  );

  return (
    <>
      {/* The set's row lives here, not in Card, because the note is this
          component's state. Keyed on the thread key so a half-typed edit
          cannot land in another set. */}
      <SetRow
        key={key === null ? "" : `${key.id ?? ""}:${key.path ?? ""}`}
        goal={goal}
        onGoalChange={changeGoal}
        note={note}
        onNoteChange={changeNote}
      />
      <div
        ref={scrollBody}
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
        {lastTime !== null && <RecapView recap={lastTime} onDismiss={() => setLastTime(null)} />}
        {folded > 0 && (
          <button className="recap__fold" onClick={() => setFolded(0)}>
            Show {folded} earlier answer{folded === 1 ? "" : "s"}<span aria-hidden="true"> ›</span>
          </button>
        )}
        {/* First launch, and any set with no thread yet. The questions are
            built from her set and land on what the reads answer well. */}
        {thread.length === 0 && recap === null && waiting === null && (
          <div className="card__empty">
            <div className="card__empty-line">Ask about the set you have open. Try one:</div>
            {starterQuestions(state).map((q) => (
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
        {thread.map((x, i) => i < folded ? null : (
          <div
            key={x.turnId ?? `${key?.id}:${key?.path}:${i}`}
            className="card__exchange"
            data-tauri-drag-region="deep"
            ref={i === thread.length - 1 ? newest : undefined}
          >
            <div className="card__question-row">
              <div className="card__question">{x.question}</div>
              {(x.answer !== null || x.error !== null) && (
                <AnswerMenu canChange={Boolean(x.turnId && x.move && x.answer !== null)} disabled={operations.install}
                  onChangeOutcome={() => { setEditing(x.turnId ?? null); if (checkin === x.turnId) setCheckin(null); }}
                  onReport={onReport && (() => onReport({ origin: x.error ? "error" : "answer", exchange: x }))} />
              )}
            </div>
            <ExchangeView x={x} />
            {x.error !== null && onReport && (
              <button className="report-link report-trigger" disabled={operations.install}
                onClick={() => onReport({ origin: "error", exchange: x })}>Report this</button>
            )}
            {x.turnId && x.move && x.answer !== null && (!busy || i !== thread.length - 1) && (
              <MoveBox exchange={{ turnId: x.turnId, move: x.move, answer: x.answer, tracksRead: x.tracksRead }}
                outcomes={outcomes} editing={editing === x.turnId} sharingEnabled={account.view?.capture === true}
                onChange={(next) => changeOutcomes(next, key)} onDone={() => setEditing(null)} />
            )}
          </div>
        ))}
        {log.length > 0 && (
          <ul className="card__reads" data-tauri-drag-region="deep">
            {log.map((line, i) => (
              <li key={i}>
                <span className="card__reads-mark" aria-hidden="true">{line.check ? "✓" : ""}</span>
                {line.text}
              </li>
            ))}
          </ul>
        )}
        {waiting !== null && (
          <div
            className={`card__progress${reading ? "" : " card__progress--thinking"}`}
            data-tauri-drag-region="deep"
          >
            {waiting}
          </div>
        )}
      </div>
      <div className="card__footer">
        {(() => {
          const open = thread.find((x) => x.turnId !== undefined && x.turnId === checkin);
          return open?.turnId && open.move && open.answer !== null && (
            <MoveCheckin exchange={{ turnId: open.turnId, move: open.move, answer: open.answer, tracksRead: open.tracksRead }}
              outcomes={outcomes} sharingEnabled={account.view?.capture === true}
              onChange={(next) => changeOutcomes(next, key)} onClose={closeCheckin} />
          );
        })()}
        {accessProblem && <div id="chat-access-status" className="card__access-status" role="status">{accessProblem}</div>}
        <input
          ref={inputRef}
          className="card__input"
          value={input}
          disabled={busy || operations.install || !wireReady(connected, state.scriptVersion, wireVersion.version) || !canAsk(account.view)}
          aria-label="Ask about the set"
          placeholder={busy ? "Answering. Ask the next one after." : "Ask about the set…"}
          aria-describedby={accessProblem ? "chat-access-status" : undefined}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          // A click counts too: after a send the input keeps focus, so no focus event follows.
          onFocus={() => offerCheckin.current()}
          onClick={() => offerCheckin.current()}
        />
        {/* Permanent and non-dismissible. From here the app can state wrong
            things fluently, in prose, about her music, and it cannot hear
            any of it. */}
        <div className="card__disclaimer">
          AI can make mistakes.
          {onReport && (() => {
            // The newest settled exchange is what a report is most likely about.
            const newest = [...thread].reverse().find((x) => x.answer !== null || x.error !== null);
            return <>{" "}<button className="card__report" disabled={operations.install}
              onClick={() => onReport(newest ? { origin: newest.error ? "error" : "answer", exchange: newest } : { origin: "settings" })}>
              Report a problem</button></>;
          })()}
        </div>
      </div>
      <WhatICanSee state={state} />
    </>
  );
}
