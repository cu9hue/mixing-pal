import { Delta, SetState, TrackState, emptyTrack } from "./model";

export function emptySet(): SetState {
  return {
    tempo: null,
    isPlaying: false,
    scaleName: null,
    rootNote: null,
    selectedTrack: null,
    tracks: {},
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
  "/live/view/get/selected_track": "selectedTrack",
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

export function applyDelta(state: SetState, delta: Delta): SetState {
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
