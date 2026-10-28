/**
 * How long a turn runs before the label admits how long it has been running.
 *
 * Below this the producer gets the verb alone: a timer on a two-second
 * answer makes a fast reply feel measured, and there is nothing to decide
 * yet. Past it the producer is waiting long enough to wonder whether the app has hung,
 * and the honest answer is a number.
 */
export const SLOW_AFTER_MS = 10_000;

export interface WaitingState {
  /** A model turn is in flight. */
  busy: boolean;
  /** Tools called so far this turn, the running one included. */
  toolsCalled: number;
  elapsedMs: number;
}

/**
 * A reasoning model can think for a minute between reads; one word that long looks
 * like a hang. No verb names an act the app could check or a sound it would hear.
 */
const VERBS = ["Thinking…", "Checking the details…", "Comparing parts…", "Working it out…", "Putting it together…"];

/** How long each verb holds: slow enough to read at a glance. */
export const VERB_MS = 4_000;

function reads(n: number): string {
  return n === 1 ? "1 read" : `${n} reads`;
}

/**
 * What the card says under the reading log while it is waiting, or null when
 * it should say nothing. The log names what is read; this line shows the turn
 * is alive, including before the first read and after the last.
 */
export function waitingLabel({ busy, toolsCalled, elapsedMs }: WaitingState): string | null {
  if (!busy) return null;
  const verb = VERBS[Math.floor(elapsedMs / VERB_MS) % VERBS.length];
  const rest = [];
  if (toolsCalled > 0) rest.push(`${reads(toolsCalled)} so far`);
  if (elapsedMs >= SLOW_AFTER_MS) rest.push(`${Math.floor(elapsedMs / 1000)}s`);
  return rest.length > 0 ? `${verb} ${rest.join(" · ")}` : verb;
}
