import { SetState } from "../live/model";

/**
 * What the producer sees while the model is fetching something.
 *
 * The rule is that this names her music, never our code. `reading Pad
 * Wide…` tells her the model is looking at the thing she just asked
 * about; `reading get_track_detail({"track":1})…` tells her she is using
 * a debugger. The raw calls are still available in the trace pane, which
 * is where a debugger belongs.
 *
 * Argument names come from the tool schema in src-tauri/src/tools/mod.rs.
 * Every tool that takes `track` gets a phrase with the track's name and a
 * fallback without it; the set-wide tools have one phrase each. One verb
 * per tool, all of them about reading the set: the app hears no audio, so
 * nothing here may say it is listening.
 *
 * The reading log shows a finished read in the past tense, so each present
 * phrase has a past twin below, in the same order.
 */
const PHRASE: Record<string, (trackName: string) => string> = {
  get_track_detail: (t) => `reading ${t}…`,
  get_clip_notes: (t) => `reading the notes in ${t}…`,
  get_arrangement_notes: (t) => `reading the arrangement notes in ${t}…`,
  get_device_params: (t) => `looking at a device on ${t}…`,
  get_rack_contents: (t) => `opening the rack on ${t}…`,
  get_sample: (t) => `looking at a sample on ${t}…`,
  get_mixer: (t) => `reading the mixer for ${t}…`,
  get_arrangement: (t) => `mapping the arrangement for ${t}…`,
};

const PAST_PHRASE: Record<string, (trackName: string) => string> = {
  get_track_detail: (t) => `read ${t}`,
  get_clip_notes: (t) => `read the notes in ${t}`,
  get_arrangement_notes: (t) => `read the arrangement notes in ${t}`,
  get_device_params: (t) => `looked at a device on ${t}`,
  get_rack_contents: (t) => `opened the rack on ${t}`,
  get_sample: (t) => `looked at a sample on ${t}`,
  get_mixer: (t) => `read the mixer for ${t}`,
  get_arrangement: (t) => `mapped the arrangement for ${t}`,
};

const FALLBACK: Record<string, string> = {
  get_track_detail: "reading a track…",
  get_clip_notes: "reading the clip…",
  get_arrangement_notes: "reading an arrangement clip…",
  get_device_params: "looking at a device…",
  get_rack_contents: "opening a rack…",
  get_sample: "looking at a sample…",
  get_clips: "listing the clips…",
  get_arrangement: "mapping the arrangement…",
  get_device_chains: "listing the devices…",
  get_mixer: "reading the mixer…",
};

const PAST_FALLBACK: Record<string, string> = {
  get_track_detail: "read a track",
  get_clip_notes: "read the clip",
  get_arrangement_notes: "read an arrangement clip",
  get_device_params: "looked at a device",
  get_rack_contents: "opened a rack",
  get_sample: "looked at a sample",
  get_clips: "listed the clips",
  get_arrangement: "mapped the arrangement",
  get_device_chains: "listed the devices",
  get_mixer: "read the mixer",
};

export function trackName(args: unknown, state: SetState): string | null {
  if (typeof args !== "object" || args === null) return null;
  const track = (args as Record<string, unknown>).track;
  if (typeof track !== "number") return null;
  // A track in the mirror whose name has not arrived yet is no better than
  // an unknown track -- "reading null…" would be worse than the fallback.
  return state.tracks[track]?.name ?? null;
}

/** One read in words. `track` is the name to put in the phrase, or null for the plain one. */
export function readLabel(name: string, track: string | null, past: boolean): string {
  const phrase = (past ? PAST_PHRASE : PHRASE)[name];
  if (track !== null && phrase !== undefined) return phrase(track);
  // A tool added later gets a plain sentence rather than leaking its name.
  return (past ? PAST_FALLBACK : FALLBACK)[name] ?? (past ? "read something" : "reading…");
}

export function progressLabel(name: string, args: unknown, state: SetState): string {
  return readLabel(name, trackName(args, state), false);
}
