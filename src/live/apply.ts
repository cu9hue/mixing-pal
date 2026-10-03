import { CuePoint, Delta, SetState, TrackState, emptyTrack } from "./model";

export function emptySet(): SetState {
  return {
    tempo: null,
    isPlaying: false,
    scaleName: null,
    rootNote: null,
    signatureNumerator: null,
    signatureDenominator: null,
    selectedTrack: null,
    tracks: {},
    scriptVersion: null,
    cuePoints: [],
    cuePointsTotal: null,
    setId: null,
    setName: null,
    setPath: null,
    loop: null,
    loopStart: null,
    loopLength: null,
    selectedDevice: null,
    selectedSlot: null,
  };
}

// Exported so a test can assert this mapping's address set never drifts
// from shared/handled-addresses.json without failing the build -- see I4 in
// the 2026-08-16 whole-branch review.
export const SONG_FIELDS: Record<string, keyof SetState> = {
  "/live/song/get/tempo": "tempo",
  "/live/song/get/is_playing": "isPlaying",
  "/live/song/get/scale_name": "scaleName",
  "/live/song/get/root_note": "rootNote",
  "/live/song/get/signature_numerator": "signatureNumerator",
  "/live/song/get/signature_denominator": "signatureDenominator",
  "/live/view/get/selected_track": "selectedTrack",
  "/live/mixingpal/get/version": "scriptVersion",
  "/live/song/get/loop": "loop",
  "/live/song/get/loop_start": "loopStart",
  "/live/song/get/loop_length": "loopLength",
};

export const TRACK_FIELDS: Record<string, keyof TrackState> = {
  "/live/track/get/name": "name",
  "/live/track/get/mute": "mute",
  "/live/track/get/solo": "solo",
  "/live/track/get/volume": "volume",
  "/live/track/get/volume_db": "volumeDb",
  "/live/track/get/panning": "panning",
  "/live/track/get/output_meter_level": "meter",
};

// Handled directly in applyDelta rather than through SONG_FIELDS: unlike a
// plain song field, num_tracks doesn't copy into a single SetState field --
// it prunes state.tracks of any index the new count no longer covers. Fix
// for F2 (2026-08-16 whole-branch review): Coalescer::evict_tracks_at_or_
// beyond already cleans Rust's own maps on a shrink, but emitted no delta,
// so a deleted track kept a phantom row (stale name/mute/solo/fader) in the
// window forever. Still listed in shared/handled-addresses.json's
// songFields so the lib.rs consistency tripwire (I4) treats it as handled;
// see addresses.test.ts's handledOutsideFieldMaps for why the exact-match
// check there excludes it from the SONG_FIELDS comparison.
export const NUM_TRACKS_ADDR = "/live/song/get/num_tracks";

// Handled directly rather than through SONG_FIELDS for the same reason
// NUM_TRACKS_ADDR is: the reply is a locator count followed by a flat
// (name, time, name, time, ...) list, not a single value to copy into one
// field.
//
// Ours, not upstream's /live/song/get/cue_points: that handler caps nothing,
// so a set with enough locators overfills the datagram, Live's sendto
// raises, and the client receives nothing at all -- every five seconds,
// forever, and indistinguishable from a set with no locators. See
// mixingpal/arrangement_replies.py's cue_points_reply.
export const CUE_POINTS_ADDR = "/live/mixingpal/get/cue_points";

// Handled directly for the same reason CUE_POINTS_ADDR is: three strings
// that become three fields, with the id-else-path choice made here. The
// connector reports only what it read from the set; the frontend is the
// one owner of the fallback. See the 2026-09-07 set identity spec.
export const SET_IDENTITY_ADDR = "/live/mixingpal/get/set_identity";

/**
 * Decodes one identity reply. Empty strings mean "none" on the wire and
 * become null here. Anything that is not three strings is a reply this
 * version does not understand, and null tells applyDelta to keep what it
 * had rather than half-apply it.
 */
export function setIdentityFrom(
  args: unknown[],
): Pick<SetState, "setId" | "setName" | "setPath"> | null {
  if (args.length !== 3 || !args.every((a) => typeof a === "string")) return null;
  const [stored, name, path] = args as [string, string, string];
  const setPath = path === "" ? null : path;
  return {
    setId: stored === "" ? setPath : stored,
    setName: name === "" ? null : name,
    setPath,
  };
}

// Handled directly: two indices that become one field. -1 means Master or a
// Return is selected, or no device is; either way nothing on a regular track.
export const SELECTED_DEVICE_ADDR = "/live/view/get/selected_device";
export const SELECTED_SLOT_ADDR = "/live/view/get/selected_clip";

function pairFrom(args: unknown[]): [number, number] | null {
  const [a, b] = args;
  if (args.length !== 2 || typeof a !== "number" || typeof b !== "number" || a < 0 || b < 0) return null;
  return [a, b];
}

export function applyDelta(state: SetState, delta: Delta): SetState {
  if (delta.addr === SELECTED_DEVICE_ADDR) {
    const pair = pairFrom(delta.args);
    const selectedDevice = pair && { track: pair[0], device: pair[1] };
    const same = selectedDevice?.track === state.selectedDevice?.track && selectedDevice?.device === state.selectedDevice?.device;
    return same ? state : { ...state, selectedDevice };
  }

  if (delta.addr === SELECTED_SLOT_ADDR) {
    const pair = pairFrom(delta.args);
    const selectedSlot = pair && { track: pair[0], scene: pair[1] };
    const same = selectedSlot?.track === state.selectedSlot?.track && selectedSlot?.scene === state.selectedSlot?.scene;
    return same ? state : { ...state, selectedSlot };
  }

  if (delta.addr === NUM_TRACKS_ADDR) {
    const n = delta.args[0];
    // A null count means "unknown", not "zero tracks" -- coercing it would
    // wipe every row in the table for no reason.
    if (typeof n !== "number") return state;
    const tracks: Record<number, TrackState> = {};
    for (const [key, track] of Object.entries(state.tracks)) {
      if (Number(key) < n) tracks[Number(key)] = track;
    }
    return { ...state, tracks };
  }

  if (delta.addr === CUE_POINTS_ADDR) {
    // The true locator count leads, then the pairs the datagram had room
    // for. Without the count, a cut reply would read as the whole set of
    // sections; with it, buildContext can say the SECTIONS line is a subset.
    const total = delta.args[0];
    if (typeof total !== "number") return state;
    const pairs = delta.args.slice(1);
    // A ragged tail is a half-decoded locator list, which would misplace
    // every section after the bad entry. Keep what we had.
    if (pairs.length % 2 !== 0) return state;
    const cuePoints: CuePoint[] = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const name = pairs[i];
      const time = pairs[i + 1];
      if (typeof name !== "string" || typeof time !== "number") return state;
      cuePoints.push({ name, time });
    }
    return { ...state, cuePoints, cuePointsTotal: total };
  }

  if (delta.addr === SET_IDENTITY_ADDR) {
    const identity = setIdentityFrom(delta.args);
    if (identity === null) return state;
    // The reply arrives once a second and almost always repeats the last
    // one; a fresh state object for an unchanged identity re-renders the
    // card for nothing.
    if (
      identity.setId === state.setId &&
      identity.setName === state.setName &&
      identity.setPath === state.setPath
    ) {
      return state;
    }
    return { ...state, ...identity };
  }

  const songField = SONG_FIELDS[delta.addr];
  if (songField) {
    return { ...state, [songField]: delta.args[0] } as SetState;
  }

  const trackField = TRACK_FIELDS[delta.addr];
  if (trackField) {
    const index = delta.args[0] as number;
    const existing = state.tracks[index] ?? emptyTrack();
    return {
      ...state,
      tracks: {
        ...state.tracks,
        [index]: { ...existing, [trackField]: delta.args[1] },
      },
    };
  }

  return state;
}
