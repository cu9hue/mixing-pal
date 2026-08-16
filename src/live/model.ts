export interface TrackState {
  name: string | null;
  volume: number | null;
  volumeDb: string | null;
  meter: number | null;
}

export interface SetState {
  tempo: number | null;
  isPlaying: boolean;
  scaleName: string | null;
  rootNote: number | null;
  selectedTrack: number | null;
  tracks: Record<number, TrackState>;
}

export interface Delta {
  addr: string;
  args: unknown[];
}

export function emptyTrack(): TrackState {
  return { name: null, volume: null, volumeDb: null, meter: null };
}
