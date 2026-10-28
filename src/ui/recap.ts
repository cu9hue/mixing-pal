import { Note, ageWords } from "../notes/note";
import { Rating, Outcome, recentOutcomes } from "../notes/outcomes";
import { Exchange } from "./thread";

/** Shorter than this, the producer still remembers; a set switch and back keeps the full thread. */
export const BREAK_SECONDS = 3 * 60 * 60;
const RATED_IN_RECAP = 3;
const DECIDED_IN_RECAP = 2;

export interface Recap {
  when: string;
  asked: string;
  rated: { outcome: Rating; move: string; heard: string }[];
  decided: string[];
}

/**
 * What the producer did last time, rebuilt from the saved set with no model call.
 * The newest move only appears once rated, so it never repeats the check-in.
 */
export function recapFor(thread: Exchange[], outcomes: Outcome[], note: Note, savedAt: number, now: number): Recap | null {
  const last = thread[thread.length - 1];
  if (last === undefined || now - savedAt < BREAK_SECONDS) return null;
  const age = ageWords(savedAt, now);
  return {
    when: age === "today" ? "earlier today" : age,
    asked: last.question,
    rated: recentOutcomes(outcomes, RATED_IN_RECAP).map(({ record }) => ({ outcome: record.outcome, move: record.move, heard: record.heard })),
    decided: note.bullets.filter((b) => b.kind === "decided").sort((a, b) => b.at - a.at).slice(0, DECIDED_IN_RECAP).map((b) => b.text),
  };
}
