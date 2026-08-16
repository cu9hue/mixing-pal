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

const SONG_FIELDS: Record<string, keyof SetState> = {
  "/live/song/get/tempo": "tempo",
  "/live/song/get/is_playing": "isPlaying",
  "/live/song/get/scale_name": "scaleName",
  "/live/song/get/root_note": "rootNote",
  "/live/view/get/selected_track": "selectedTrack",
};

const TRACK_FIELDS: Record<string, keyof TrackState> = {
  "/live/track/get/name": "name",
  "/live/track/get/mute": "mute",
  "/live/track/get/solo": "solo",
  "/live/track/get/volume": "volume",
  "/live/track/get/volume_db": "volumeDb",
  "/live/track/get/panning": "panning",
  "/live/track/get/output_meter_level": "meter",
};

export function applyDelta(state: SetState, delta: Delta): SetState {
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
