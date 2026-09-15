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
  feedback?: Feedback;
}

export interface Feedback {
  outcome: "kept" | "undone" | "tried" | "not_tried";
  heard: string;
  shared: boolean;
}

export function begin(thread: Exchange[], question: string, turnId?: string): Exchange[] {
  return [...thread, { question, answer: null, error: null, ...(turnId ? { turnId } : {}) }];
}

export function complete(thread: Exchange[], answer: string): Exchange[] {
  return settle(thread, { answer, error: null });
}

export function fail(thread: Exchange[], error: string): Exchange[] {
  return settle(thread, { answer: null, error });
}

function settle(thread: Exchange[], outcome: Pick<Exchange, "answer" | "error">): Exchange[] {
  const last = thread[thread.length - 1];
  return [...thread.slice(0, -1), { ...last, ...outcome }];
}
