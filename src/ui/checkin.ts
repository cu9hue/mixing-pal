import { Outcome, latestFor } from "../notes/outcomes";
import { Exchange } from "./thread";

/**
 * The one exchange the check-in may ask about: the newest, when its move is
 * neither rated nor set aside. Older moves are never chased.
 */
export function checkinTarget(
  thread: Exchange[], outcomes: Outcome[], dismissed: ReadonlySet<string>, busy: boolean,
): Exchange | null {
  if (busy) return null;
  const newest = thread[thread.length - 1];
  if (!newest?.turnId || !newest.move || newest.answer === null) return null;
  if (dismissed.has(newest.turnId) || latestFor(outcomes, newest.turnId) !== null) return null;
  return newest;
}
