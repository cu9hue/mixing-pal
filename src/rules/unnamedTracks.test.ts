import { describe, it, expect } from "vitest";
import { unnamedTracks, MIN_UNNAMED, MIN_TRACKS } from "./unnamedTracks";
import { SetState, emptyTrack } from "../live/model";

function setOf(names: Array<string | null>): SetState {
  const tracks: SetState["tracks"] = {};
  names.forEach((name, i) => {
    tracks[i] = { ...emptyTrack(), name };
  });
  return {
    tempo: 128,
    isPlaying: false,
    scaleName: null,
    rootNote: null,
    selectedTrack: null,
    scriptVersion: 2,
    tracks,
  };
}

const NAMED = ["Kick", "Snare", "808 Sub", "Pad Wide", "Vox Chop"];

describe("unnamedTracks", () => {
  it("fires when enough tracks in a big enough set still carry default names", () => {
    const state = setOf([
      ...NAMED,
      "1 MIDI",
      "2 MIDI",
      "3 Audio",
      "4 Audio",
      "5 MIDI",
      "6 MIDI",
    ]);
    expect(unnamedTracks(state)).toEqual({
      id: "unnamed_tracks",
      text: "Six tracks are still named MIDI or Audio.",
    });
  });

  it("stays quiet in a small set, however scruffy", () => {
    const state = setOf(["1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI", "6 MIDI"]);
    expect(state.tracks[0]).toBeDefined();
    expect(unnamedTracks(state)).toBeNull();
  });

  it("stays quiet when only a few are unnamed", () => {
    const state = setOf([...NAMED, "Bass", "Hat", "Ride", "Perc", "1 MIDI", "2 Audio"]);
    expect(unnamedTracks(state)).toBeNull();
  });

  it("spells the count in words up to ten and uses digits past it", () => {
    const seven = setOf([
      ...NAMED,
      "1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI", "6 MIDI", "7 MIDI",
    ]);
    expect(unnamedTracks(seven)?.text).toBe("Seven tracks are still named MIDI or Audio.");

    const eleven = setOf([
      ...NAMED,
      "1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI",
      "6 MIDI", "7 MIDI", "8 MIDI", "9 MIDI", "10 MIDI", "11 MIDI",
    ]);
    expect(unnamedTracks(eleven)?.text).toBe("11 tracks are still named MIDI or Audio.");
  });

  it("recognises the default shapes Live can produce", () => {
    const state = setOf([
      ...NAMED,
      "MIDI", "Audio", "1 MIDI", "2-Audio", "3 midi", "4 AUDIO",
    ]);
    expect(unnamedTracks(state)?.text).toBe("Six tracks are still named MIDI or Audio.");
  });

  it("does not count a track the producer deliberately named", () => {
    const state = setOf([
      ...NAMED,
      "MIDI Bus", "Audio Ref", "Sub MIDI", "1 MIDI", "2 MIDI", "3 MIDI",
    ]);
    // Only the three bare defaults count, which is below the threshold.
    expect(unnamedTracks(state)).toBeNull();
  });

  it("does not count a track whose name has not arrived from Live yet", () => {
    const state = setOf([
      ...NAMED,
      null, null, null, null, null, null,
    ]);
    expect(unnamedTracks(state)).toBeNull();
  });

  // Both boundaries, from the spec's Testing section. An off-by-one here
  // makes the one rule that ships either fire on a sketch or stay silent
  // on the set it was written for.
  it("fires at exactly the boundary: ten tracks, six of them default", () => {
    const state = setOf([
      ...NAMED.slice(0, 4),
      "1 MIDI", "2 MIDI", "3 MIDI", "4 Audio", "5 Audio", "6 Audio",
    ]);
    expect(Object.keys(state.tracks)).toHaveLength(MIN_TRACKS);
    expect(unnamedTracks(state)?.text).toBe("Six tracks are still named MIDI or Audio.");
  });

  it("stays quiet one track below the set-size boundary", () => {
    const state = setOf([
      ...NAMED.slice(0, 3),
      "1 MIDI", "2 MIDI", "3 MIDI", "4 Audio", "5 Audio", "6 Audio",
    ]);
    expect(Object.keys(state.tracks)).toHaveLength(MIN_TRACKS - 1);
    expect(unnamedTracks(state)).toBeNull();
  });

  it("stays quiet one default below the count boundary", () => {
    const state = setOf([
      ...NAMED,
      "1 MIDI", "2 MIDI", "3 MIDI", "4 Audio", "5 Audio",
    ]);
    expect(Object.keys(state.tracks)).toHaveLength(MIN_TRACKS);
    expect(unnamedTracks(state)).toBeNull();
  });

  it("exposes its thresholds so the copy and the test cannot drift", () => {
    expect(MIN_UNNAMED).toBe(6);
    expect(MIN_TRACKS).toBe(10);
  });
});
