export interface TrackState {
  name: string | null;
  mute: boolean | null;
  solo: boolean | null;
  volume: number | null;
  volumeDb: string | null;
  panning: number | null;
  meter: number | null;
}

/// One of the producer's locators: a name and its position in beats.
export interface CuePoint {
  name: string;
  time: number;
}

export interface SetState {
  tempo: number | null;
  isPlaying: boolean;
  scaleName: string | null;
  rootNote: number | null;
  signatureNumerator: number | null;
  signatureDenominator: number | null;
  selectedTrack: number | null;
  tracks: Record<number, TrackState>;
  scriptVersion: number | null;
  cuePoints: CuePoint[];
  /// How many locators the set really has. The connector cuts the reply to
  /// one datagram, so a set with hundreds of them sends a prefix; without
  /// the true count the digest would present that prefix as the whole
  /// structure. Null until a reply arrives.
  cuePointsTotal: number | null;
  /// The set's identity, from /live/mixingpal/get/set_identity. setId is
  /// the id stored in the set, else its path, else null; the choice is
  /// made in apply.ts's setIdentityFrom. All null until the first reply.
  setId: string | null;
  setName: string | null;
  setPath: string | null;
  /// The arrangement loop brace, in beats: where the producer is working, when on.
  loop: boolean | null;
  loopStart: number | null;
  loopLength: number | null;
  /// The selected device by index on its track, and the selected Session
  /// slot. Null when nothing on a regular track is selected.
  selectedDevice: { track: number; device: number } | null;
  selectedSlot: { track: number; scene: number } | null;
}

export interface Delta {
  addr: string;
  args: unknown[];
}

export function emptyTrack(): TrackState {
  return {
    name: null,
    mute: null,
    solo: null,
    volume: null,
    volumeDb: null,
    panning: null,
    meter: null,
  };
}
