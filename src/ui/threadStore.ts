import { ChatMessage } from "../agent/loop";
import { SetState } from "../live/model";
import { Exchange } from "./thread";

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
 * Whether the card should switch from the thread it shows to the set's.
 * Only on a change to a real identity, never on a change to none (the
 * connector gone, or an unsaved set: nothing on screen changes and nothing
 * is saved), and never while a turn is running, so an answer can only
 * ever land in the thread its question was asked in.
 */
export function shouldSwitch(current: ThreadKey | null, next: ThreadKey | null, busy: boolean): boolean {
  if (next === null || busy) return false;
  return current === null || current.id !== next.id;
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
export function recapLine(count: number, savedAt: number, now: number): string {
  const days = Math.max(0, Math.floor((now - savedAt) / (24 * 60 * 60)));
  const when = days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
  return `Earlier on this set · ${count} exchange${count === 1 ? "" : "s"} · last ${when}`;
}
