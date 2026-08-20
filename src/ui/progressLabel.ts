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
 * Both tools take `track`; get_clip_notes also takes `clip`.
 */
const PHRASE: Record<string, (trackName: string) => string> = {
  get_track_detail: (t) => `reading ${t}…`,
  get_clip_notes: (t) => `reading the notes in ${t}…`,
};

const FALLBACK: Record<string, string> = {
  get_track_detail: "reading a track…",
  get_clip_notes: "reading the clip…",
};

function trackName(args: unknown, state: SetState): string | null {
  if (typeof args !== "object" || args === null) return null;
  const track = (args as Record<string, unknown>).track;
  if (typeof track !== "number") return null;
  // A track in the mirror whose name has not arrived yet is no better than
  // an unknown track -- "reading null…" would be worse than the fallback.
  return state.tracks[track]?.name ?? null;
}

export function progressLabel(name: string, args: unknown, state: SetState): string {
  const resolved = trackName(args, state);
  const phrase = PHRASE[name];
  if (resolved !== null && phrase !== undefined) return phrase(resolved);
  // A tool added later gets a plain sentence rather than leaking its name.
  return FALLBACK[name] ?? "reading…";
}
