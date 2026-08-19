import { SetState } from "../live/model";
import { keyName } from "../digest/build";

/**
 * Same honest-unknown wording as the digest's SET line: "tempo unknown"
 * rather than "0 BPM", "no key set" rather than a guessed key. Kept in sync
 * by calling keyName directly instead of re-deriving it.
 */
export function summaryLine(state: SetState, trackCount: number): string {
  const tempo = state.tempo === null ? "tempo unknown" : `${state.tempo} BPM`;
  const key = keyName(state.rootNote, state.scaleName) ?? "no key set";
  return `${trackCount} track${trackCount === 1 ? "" : "s"} · ${tempo} · ${key}`;
}
