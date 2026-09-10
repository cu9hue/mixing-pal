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
  /** Tools called so far this turn, the running one included. */
  toolsCalled: number;
  elapsedMs: number;
}

function reads(n: number): string {
  return n === 1 ? "1 read" : `${n} reads`;
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
 *
 * A turn is mostly reading, not thinking, and the line says how much: the
 * count of reads rides on the tool line from the second read on, and on the
 * thinking line once there has been one. The verb stays "Thinking" between
 * reads because the app cannot tell whether the model is writing or about
 * to read again, and a verb that guesses would be wrong half the time.
 */
export function waitingLabel({ busy, toolProgress, toolsCalled, elapsedMs }: WaitingState): string | null {
  if (!busy) return null;
  if (toolProgress !== null) {
    return toolsCalled > 1 ? `${toolProgress} · ${reads(toolsCalled)}` : toolProgress;
  }
  const parts = ["Thinking…"];
  if (toolsCalled > 0) parts.push(`${reads(toolsCalled)} so far`);
  if (elapsedMs >= SLOW_AFTER_MS) parts.push(`${Math.floor(elapsedMs / 1000)}s`);
  return parts.join(" · ").replace("Thinking… · ", "Thinking… ");
}
