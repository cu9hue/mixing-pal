import { SetState } from "../live/model";
import { Nudge } from "./nudges";

/**
 * Live's default track names. Verified shapes: a bare "MIDI"/"Audio" and a
 * numbered "1 MIDI"/"2-Audio". Case-insensitive because the exact casing
 * is not worth depending on.
 *
 * Anchored at both ends on purpose: "MIDI Bus" and "Sub MIDI" are names
 * the producer chose, and counting them would make this rule wrong -- which
 * is the one thing it must never be.
 *
 * MANUAL VERIFICATION REQUIRED: confirm against a real Live 12 set before
 * trusting this rule. See docs/manual-verification.md.
 */
export const DEFAULT_NAME = /^(?:\d+[-\s]+)?(?:MIDI|Audio)$/i;

/** Below this many defaults it is tidiness, not a problem worth a nudge. */
export const MIN_UNNAMED = 6;

/** Below this many tracks it is a sketch, and naming things is premature. */
export const MIN_TRACKS = 10;

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five",
  "Six", "Seven", "Eight", "Nine", "Ten",
];

/**
 * Numbers up to ten in words. The nudge sits next to the model's prose and
 * should read in the same register -- "Seven tracks", not "7 tracks", which
 * is the register of a linter.
 */
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

/**
 * Fires when a set has grown past sketch size and most of it is still
 * called MIDI and Audio.
 *
 * This is the first nudge that ships, and it was chosen because it cannot
 * be wrong: it is a count of strings, with no inference and no judgement
 * about the music. A wrong nudge costs more trust than a missing one.
 */
export function unnamedTracks(state: SetState): Nudge | null {
  const names = Object.values(state.tracks).map((t) => t.name);
  if (names.length < MIN_TRACKS) return null;

  // A null name is a track whose name has not arrived from Live yet, not a
  // track called nothing. Counting it would make the nudge fire during the
  // first second of every session, before the mirror has filled in.
  const count = names.filter((n) => n !== null && DEFAULT_NAME.test(n)).length;
  if (count < MIN_UNNAMED) return null;

  return {
    id: "unnamed_tracks",
    text: `${spell(count)} tracks are still named MIDI or Audio.`,
  };
}
