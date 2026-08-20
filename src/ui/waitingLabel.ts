/**
 * How long a turn runs before the label admits how long it has been running.
 *
 * Below this the producer gets a plain "Thinking…": a timer on a two-second
 * answer makes a fast reply feel measured, and there is nothing to decide
 * yet. Past it she is waiting long enough to wonder whether the app has hung,
 * and the honest answer is a number.
 */
export const SLOW_AFTER_MS = 10_000;

export interface WaitingState {
  /** A model turn is in flight. */
  busy: boolean;
  /** The tool currently running, from progressLabel. Null between tools. */
  toolProgress: string | null;
  elapsedMs: number;
}

/**
 * What the card says while it is waiting, or null when it should say nothing.
 *
 * Three things happen in one turn and only one of them used to be visible.
 * The tool line covers the middle — "reading Pad Wide…" — but the model's
 * first round-trip before any tool runs, a turn that calls no tools at all,
 * and the final stretch while the model writes prose were all silent. This
 * fills those gaps without displacing the tool line, which names her music
 * and is strictly the better thing to show when it applies.
 */
export function waitingLabel({ busy, toolProgress, elapsedMs }: WaitingState): string | null {
  if (!busy) return null;
  if (toolProgress !== null) return toolProgress;
  if (elapsedMs < SLOW_AFTER_MS) return "Thinking…";
  return `Thinking… ${Math.floor(elapsedMs / 1000)}s`;
}
