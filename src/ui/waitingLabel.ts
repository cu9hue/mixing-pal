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

/**
 * What the card says between reads, in turn. A reasoning model can think for
 * a minute without a read, and one word for a minute looks like a hang. The
 * verbs are plain and name no act the app could check or a sound it cannot
 * hear, so none of them can be wrong about what the model is doing.
 */
const VERBS = ["Thinking…", "Checking the details…", "Comparing parts…", "Working it out…", "Putting it together…"];

/** How long each verb holds: slow enough to read at a glance. */
export const VERB_MS = 4_000;

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
 * The count of reads rides on the tool line from the second read on, and on
 * the thinking line once there has been one.
 */
export function waitingLabel({ busy, toolProgress, toolsCalled, elapsedMs }: WaitingState): string | null {
  if (!busy) return null;
  if (toolProgress !== null) {
    return toolsCalled > 1 ? `${toolProgress} · ${reads(toolsCalled)}` : toolProgress;
  }
  const verb = VERBS[Math.floor(elapsedMs / VERB_MS) % VERBS.length];
  const rest = [];
  if (toolsCalled > 0) rest.push(`${reads(toolsCalled)} so far`);
  if (elapsedMs >= SLOW_AFTER_MS) rest.push(`${Math.floor(elapsedMs / 1000)}s`);
  return rest.length > 0 ? `${verb} ${rest.join(" · ")}` : verb;
}
