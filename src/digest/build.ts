import { SetState } from "../live/model";
import { fence } from "./fence";

const PITCH_CLASSES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

// Live always reports a root note, so scale_name is the field that says
// whether the producer actually set a key. Naming one they never chose would
// invite harmonic advice against a key that isn't there.
export function keyName(rootNote: number | null, scaleName: string | null): string | null {
  if (rootNote === null || scaleName === null || scaleName === "") return null;
  const pitch = PITCH_CLASSES[((rootNote % 12) + 12) % 12];
  return pitch === undefined ? null : `${pitch} ${scaleName}`;
}

/**
 * The context block sent as an ordinary user turn ahead of the producer's
 * question.
 *
 * Deliberately small: tempo, key, goal, and one line per track. Everything
 * else the model fetches with a tool. A fat digest would spend context on
 * data most questions never touch, and would make the tools decorative -- a
 * model that already has the answer in front of it does not call them.
 *
 * Every set-derived string is fenced. See fence.ts.
 */
export function buildContext(state: SetState, goal: string): string {
  const lines: string[] = [];

  const key = keyName(state.rootNote, state.scaleName);
  lines.push(
    `SET  ${state.tempo === null ? "tempo unknown" : `${state.tempo} BPM`}` +
      `${key ? ` · ${key}` : " · no key set"}` +
      ` · ${state.isPlaying ? "playing" : "stopped"}`,
  );

  const trimmedGoal = goal.trim();
  if (trimmedGoal !== "") lines.push(`GOAL  ${trimmedGoal}`);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  lines.push("");
  lines.push(`TRACKS  (${indices.length})`);
  for (const i of indices) {
    const t = state.tracks[i];
    const flags = [
      t.mute ? "muted" : "",
      t.solo ? "soloed" : "",
      state.selectedTrack === i ? "— selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    lines.push(
      ` ${i} ${fence(t.name ?? "")}${t.volumeDb ? ` ${t.volumeDb}` : ""}${flags ? ` ${flags}` : ""}`.trimEnd(),
    );
  }

  lines.push("");
  lines.push(
    "This is everything cached locally. For pan, exact fader values, or a " +
      "track's full mixer state use get_track_detail; for which clips exist " +
      "and which tracks are MIDI use get_clips; for the notes in a clip " +
      "use get_clip_notes; for what devices are on each track use " +
      "get_device_chains; for what is inside a Rack use get_rack_contents; " +
      "for one device's parameter values use get_device_params.",
  );
  return lines.join("\n");
}
