import { SetState } from "../live/model";

/** Live's names for a new track ("1 MIDI", "2-Audio"), which say nothing about the music. */
const DEFAULT_NAME = /^\d+[\s-]+(midi|audio)$/i;

function realName(name: string | null | undefined): string | null {
  const trimmed = name?.trim() ?? "";
  return trimmed === "" || DEFAULT_NAME.test(trimmed) ? null : trimmed;
}

/**
 * Three questions about the open set, each answerable from reads rather than by ear.
 * A click fills the input and leaves the send to the producer.
 */
export function starterQuestions(state: SetState): string[] {
  const cues = [...state.cuePoints].sort((a, b) => a.time - b.time);
  const named = cues.filter((c) => c.name.trim() !== "");
  // A locator at the very start is usually "Intro"; a later one makes a better question.
  const section = named.find((c) => c.time > 0) ?? named[0];
  const trackName = (i: number | null) => (i === null ? null : realName(state.tracks[i]?.name));
  const track = trackName(state.selectedTrack)
    ?? Object.keys(state.tracks).map(Number).sort((a, b) => a - b).map(trackName).find((n) => n !== null)
    ?? null;
  return [
    section ? `What plays in ${section.name.trim()}, and what's missing?` : "What comes in when in the first 16 bars?",
    track ? `What's on the ${track} chain, and what would you try?` : "What's on the selected track's chain, and what would you try?",
    cues.length === 0 ? "I'm stuck at 8 bars. How do I turn this into a full track?" : "What should I work on next to finish this track?",
  ];
}
