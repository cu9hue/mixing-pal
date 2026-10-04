/**
 * One question and what came back for it. The card shows every exchange of
 * the session, newest last; the thread is what she reads, and is separate
 * from the history window the model is sent.
 */
export interface Exchange {
  question: string;
  answer: string | null;
  /** What went wrong, shown where the answer would have been. */
  error: string | null;
  turnId?: string;
  accountId?: string;
  feedback?: Feedback;
  /** The model's name for the move this answer gives; see src/notes/move.ts. */
  move?: string;
  /** Tracks the model read for this answer, by name at the time. */
  tracksRead?: string[];
}

export interface Feedback {
  outcome: "kept" | "undone" | "tried" | "not_tried";
  heard: string;
  shared: boolean;
}

export function begin(thread: Exchange[], question: string, turnId?: string, accountId?: string): Exchange[] {
  return [...thread, { question, answer: null, error: null, ...(turnId ? { turnId } : {}), ...(accountId ? { accountId } : {}) }];
}

export function complete(thread: Exchange[], answer: string, details: Pick<Exchange, "move" | "tracksRead"> = {}): Exchange[] {
  return settle(thread, { answer, error: null, ...details });
}

export function fail(thread: Exchange[], error: string): Exchange[] {
  return settle(thread, { answer: null, error });
}

function settle(thread: Exchange[], outcome: Pick<Exchange, "answer" | "error" | "move" | "tracksRead">): Exchange[] {
  const last = thread[thread.length - 1];
  return [...thread.slice(0, -1), { ...last, ...outcome }];
}
