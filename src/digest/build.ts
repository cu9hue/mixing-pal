import { SetState } from "../live/model";
import { Bullet, ageWords } from "../notes/note";
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

function currentBeatsPerBar(state: SetState): number | null {
  const numerator = state.signatureNumerator;
  const denominator = state.signatureDenominator;
  if (numerator === null || denominator === null || numerator <= 0 || denominator <= 0) {
    return null;
  }
  const beats = (numerator * 4) / denominator;
  return Number.isFinite(beats) && beats > 0 ? beats : null;
}

function trackLabel(state: SetState, track: number): string {
  return `${fence(state.tracks[track]?.name ?? "")}`;
}

/**
 * Where she is working, from what the mirror already holds. The device is
 * an index, because the mirror holds no device names.
 */
function focusParts(state: SetState): string[] {
  const parts: string[] = [];
  const { loop, loopStart, loopLength } = state;
  if (loop && loopStart !== null && loopLength !== null && loopLength > 0) {
    const beatsPerBar = currentBeatsPerBar(state);
    const end = loopStart + loopLength;
    if (beatsPerBar === null) {
      parts.push(`loop brace beats ${loopStart}–${end}`);
    } else {
      const snap = (beat: number) => Math.round(beat * 4) / 4;
      const first = Math.floor(snap(loopStart) / beatsPerBar) + 1;
      const last = Math.max(first, Math.ceil(snap(end) / beatsPerBar));
      parts.push(first === last ? `loop brace bar ${first}` : `loop brace bars ${first}–${last}`);
    }
  }
  if (state.selectedDevice) {
    parts.push(`selected device ${state.selectedDevice.device} on ${trackLabel(state, state.selectedDevice.track)}`);
  }
  if (state.selectedSlot) {
    parts.push(`selected Session slot ${state.selectedSlot.scene} on ${trackLabel(state, state.selectedSlot.track)}`);
  }
  return parts;
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
export function buildContext(
  state: SetState,
  goal: string,
  note: Bullet[] = [],
  now: number = Math.floor(Date.now() / 1000),
): string {
  const lines: string[] = [];

  const key = keyName(state.rootNote, state.scaleName);
  lines.push(
    `SET  ${state.tempo === null ? "tempo unknown" : `${state.tempo} BPM`}` +
      `${key ? ` · ${key}` : " · no key set"}` +
      ` · ${state.isPlaying ? "playing" : "stopped"}`,
  );

  if (state.cuePoints.length > 0) {
    // Sorted by time rather than left in reply order. Live appears to hand
    // its locators over in timeline order, but nothing in this repo verifies
    // that, and an out-of-order SECTIONS line would mislead the model about
    // the structure of the set while looking perfectly well-formed. It is
    // rendered into every prompt, so it does not depend on an unverified
    // upstream guarantee.
    const beatsPerBar = currentBeatsPerBar(state);
    const sections = [...state.cuePoints]
      .sort((a, b) => a.time - b.time)
      // The beat is the fact and stays first: it is right whatever the
      // signature is. The bar is a reading of it under the signature the
      // mirror holds now, which can be stale for a few seconds after a set
      // switch, so it rides in parentheses and the header says what it
      // assumes. Snapped to the nearest sixteenth first, the way the Rust
      // tools do, so a locator a hair before a bar line is that bar.
      .map((c) => {
        if (beatsPerBar === null) return `${fence(c.name)} ${c.time}`;
        const snapped = Math.round(c.time * 4) / 4;
        return `${fence(c.name)} ${c.time} (bar ${Math.floor(snapped / beatsPerBar) + 1})`;
      })
      .join(", ");
    // The connector cuts the locator reply to one datagram and sends the
    // true count beside it. Saying nothing here would present a prefix as
    // the whole arrangement.
    const total = state.cuePointsTotal;
    const cut =
      total !== null && total > state.cuePoints.length
        ? ` (first ${state.cuePoints.length} of ${total}; the rest did not fit one reply)`
        : "";
    const unit = beatsPerBar === null
      ? "beats"
      : `beats; bars assume ${state.signatureNumerator}/${state.signatureDenominator}`;
    lines.push(`SECTIONS (${unit})  ${sections}${cut}`);
  }

  const focus = focusParts(state);
  if (focus.length > 0) lines.push(`FOCUS  ${focus.join(" · ")}`);

  const trimmedGoal = goal.trim();
  if (trimmedGoal !== "") lines.push(`GOAL  ${trimmedGoal}`);

  // The set's outcomes, hers and the model's. Ids so a retirement can name
  // one; ages in the recap line's words; "hers" so the model knows what it
  // cannot retire. The text is fenced like every other string the model did
  // not write this turn: a bullet is the model's own paraphrase of set data,
  // or hers, and neither is an instruction. The model adds to this through a
  // fenced note block and never rewrites it; see src/notes/note.ts.
  if (note.length > 0) {
    lines.push("NOTES");
    for (const b of note) {
      const hers = b.hers ? ", hers" : "";
      lines.push(`- [${b.id}] ${b.kind}  ${fence(b.text)}  (${ageWords(b.at, now)}${hers})`);
    }
  }

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
      "for what plays where on the timeline use get_arrangement; " +
      "for the notes in a timeline clip use get_arrangement_notes; " +
      "for one device's parameter values use get_device_params; " +
      "for sends, routing, returns, the master, and automation use get_mixer.",
  );
  return lines.join("\n");
}
