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

/**
 * The disclosure's Set line. Its job, like the rest of the panel, is proof
 * that the app reads the set, and the set's name is the plainest proof
 * there is. The suffix is the one place she can see that a thread for this
 * set will not follow a rename: the id fell back to the path, or there is
 * none yet. Null until a reply names the set, so an unnamed line never
 * renders as "Set" with nothing after it.
 */
export function setLine(state: SetState): string | null {
  if (state.setName === null) return null;
  const stored = state.setId !== null && state.setId !== state.setPath;
  return `Set  ${state.setName}${stored ? "" : " · no stored id"}`;
}
