import type { SetState } from "../live/model";

/**
 * A set's outcome log: every rating of an answer's move, kept for the life of
 * the set. The context block shows a view rebuilt from it, never the log.
 */
export type Rating = "kept" | "undone";

export interface Outcome {
  turnId: string;
  move: string;
  outcome: Rating;
  heard: string;
  /** Tracks the model read in that turn, by name at the time. */
  tracks: string[];
  answer: string;
  /** Seconds since the epoch. */
  at: number;
}

export interface RatedExchange {
  turnId: string;
  move: string;
  answer: string;
  tracksRead?: string[];
}

export const OUTCOME_TEXT_MAX_CHARS = 4000;
export const OUTCOMES_IN_VIEW = 6;

function cut(text: string): string {
  return Array.from(text).slice(0, OUTCOME_TEXT_MAX_CHARS).join("");
}

function latestIndex(log: Outcome[], turnId: string): number {
  for (let i = log.length - 1; i >= 0; i--) if (log[i].turnId === turnId) return i;
  return -1;
}

export function rate(log: Outcome[], exchange: RatedExchange, outcome: Rating, now: number): Outcome[] {
  return [...log, {
    turnId: exchange.turnId, move: exchange.move, outcome, heard: "",
    tracks: exchange.tracksRead ?? [], answer: cut(exchange.answer), at: now,
  }];
}

/** Her re-tap on the highlighted choice: a wrong tap leaves no memory. */
export function clear(log: Outcome[], turnId: string): Outcome[] {
  const i = latestIndex(log, turnId);
  return i < 0 ? log : [...log.slice(0, i), ...log.slice(i + 1)];
}

export function setHeard(log: Outcome[], turnId: string, text: string): Outcome[] {
  const i = latestIndex(log, turnId);
  if (i < 0) return log;
  return log.map((o, j) => (j === i ? { ...o, heard: cut(text.trim()) } : o));
}

export function latestFor(log: Outcome[], turnId: string): Outcome | null {
  const i = latestIndex(log, turnId);
  return i < 0 ? null : log[i];
}

/** One line per answer: its latest record, and the latest earlier rating that differs from it. */
export function recentOutcomes(log: Outcome[], max: number): { record: Outcome; before: Rating | null }[] {
  const byTurn = new Map<string, { record: Outcome; index: number; before: Rating | null }>();
  log.forEach((record, index) => {
    const seen = byTurn.get(record.turnId);
    const before = seen === undefined ? null : seen.record.outcome !== record.outcome ? seen.record.outcome : seen.before;
    byTurn.set(record.turnId, { record, index, before });
  });
  return [...byTurn.values()]
    .sort((a, b) => b.record.at - a.record.at || b.index - a.index)
    .slice(0, max)
    .map(({ record, before }) => ({ record, before }));
}

export function withTrackRead(tracks: string[], args: unknown, state: SetState): string[] {
  const index = typeof args === "object" && args !== null ? (args as { track?: unknown }).track : undefined;
  if (typeof index !== "number") return tracks;
  const name = state.tracks[index]?.name;
  return !name || tracks.includes(name) ? tracks : [...tracks, name];
}
