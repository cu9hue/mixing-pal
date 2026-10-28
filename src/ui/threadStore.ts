import { ChatMessage } from "../agent/loop";
import { SetState } from "../live/model";
import { Exchange } from "./thread";
import { Bullet, Note, addBullet, ageWords } from "../notes/note";

/**
 * The identity a thread is filed under: the set's stored id, or its path
 * while it has none. The Rust side looks a thread up by id first and by
 * path second, so the path rides along for the adoption cases.
 */
export interface ThreadKey {
  id: string;
  path: string | null;
}

/**
 * How long a new identity must hold before the card switches threads. A
 * late reply from the old set can flip identity back for one poll; one
 * poll is a second, so anything that holds this long is real.
 */
export const SWITCH_HOLD_MS = 1500;

export function keyFor(state: SetState): ThreadKey | null {
  return state.setId === null ? null : { id: state.setId, path: state.setPath };
}

/**
 * What the card does when the mirror's identity differs from the key its
 * thread is filed under.
 *
 * "switch": another set is open; load its thread. "rekey": the same set
 * under a new name, so keep the thread on screen and file it under the
 * new key. Two cases are the same set: the promotion from a path-derived
 * id to a stored one that every new set goes through (same path, new id),
 * and a Save As or move (same stored id, new path). "none" on a change to
 * no identity (the connector gone, or an unsaved set: nothing on screen
 * changes and nothing is saved) and while a turn is running, so an answer
 * can only ever land in the thread its question was asked in.
 */
export function classify(
  current: ThreadKey | null,
  next: ThreadKey | null,
  busy: boolean,
): "none" | "switch" | "rekey" {
  if (next === null || busy) return "none";
  if (current === null) return "switch";
  if (current.id === next.id) return current.path === next.path ? "none" : "rekey";
  if (current.path && current.path === next.path) return "rekey";
  return "switch";
}

/**
 * The model's history window, rebuilt from a restored thread: each
 * answered exchange as a user turn and an assistant turn, the most recent
 * `max` messages. Failed exchanges have no answer and are left out.
 */
export function historyFrom(exchanges: Exchange[], max: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const x of exchanges) {
    if (x.answer === null) continue;
    messages.push({ role: "user", content: x.question });
    messages.push({ role: "assistant", content: x.answer });
  }
  return messages.slice(-max);
}

/**
 * The dim line above a restored thread. `savedAt` and `now` are seconds
 * since the epoch, the unit the Rust side saves.
 */
/**
 * The note a set switch lands on: what the file holds, plus, when this is
 * the first identity of the session (`firstKey`), the bullets the producer added
 * before it arrived, the way the exchanges are carried. `carried` says
 * whether anything was folded in, which is what decides a save: a carried
 * bullet with no carried exchange would otherwise live only on screen.
 */
export function carryNote(
  saved: { note: Bullet[]; next_bullet: number } | null,
  current: Note,
  firstKey: boolean,
): { note: Note; carried: boolean } {
  let note: Note = { bullets: saved?.note ?? [], next: saved?.next_bullet ?? 0 };
  if (!firstKey) return { note, carried: false };
  for (const b of current.bullets) note = addBullet(note, b.kind, b.text, b.hers, b.at);
  return { note, carried: current.bullets.length > 0 };
}

export function recapLine(count: number, savedAt: number, now: number): string {
  return `Earlier on this set · ${count} exchange${count === 1 ? "" : "s"} · last ${ageWords(savedAt, now)}`;
}
