import { describe, it, expect } from "vitest";
import { progressLabel, readLabel } from "./progressLabel";
import { SetState } from "../live/model";
import { emptyTrack } from "../live/model";

const STATE: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: "Minor",
  rootNote: 9,
  signatureNumerator: null,
  signatureDenominator: null,
  selectedTrack: 1,
  scriptVersion: 2,
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
  tracks: {
    0: { ...emptyTrack(), name: "Kick" },
    1: { ...emptyTrack(), name: "Pad Wide" },
    2: { ...emptyTrack(), name: null },
  },
};

describe("progressLabel", () => {
  it("names the track a track lookup is about", () => {
    expect(progressLabel("get_track_detail", { track: 1 }, STATE)).toBe("reading Pad Wide…");
  });

  it("names the track a note lookup is about", () => {
    expect(progressLabel("get_clip_notes", { track: 0, clip: 2 }, STATE)).toBe(
      "reading the notes in Kick…",
    );
  });

  it("falls back per tool when the track index is not in the mirror", () => {
    expect(progressLabel("get_track_detail", { track: 99 }, STATE)).toBe("reading a track…");
    expect(progressLabel("get_clip_notes", { track: 99, clip: 0 }, STATE)).toBe(
      "reading the clip…",
    );
  });

  it("names the track for every per-track tool, and has a phrase for every set-wide one", () => {
    expect(progressLabel("get_arrangement_notes", { track: 1, index: 0 }, STATE)).toBe(
      "reading the arrangement notes in Pad Wide…",
    );
    expect(progressLabel("get_device_params", { track: 0, path: "0" }, STATE)).toBe(
      "looking at a device on Kick…",
    );
    expect(progressLabel("get_rack_contents", { track: 0, path: "0" }, STATE)).toBe(
      "opening the rack on Kick…",
    );
    expect(progressLabel("get_clips", {}, STATE)).toBe("listing the clips…");
    expect(progressLabel("get_mixer", {}, STATE)).toBe("reading the mixer…");
    expect(progressLabel("get_mixer", { track: 1 }, STATE)).toBe("reading the mixer for Pad Wide…");
    expect(progressLabel("get_arrangement", {}, STATE)).toBe("mapping the arrangement…");
    expect(progressLabel("get_device_chains", {}, STATE)).toBe("listing the devices…");
  });

  it("names the track a timeline map is about", () => {
    expect(progressLabel("get_arrangement", { track: 1 }, STATE)).toBe("mapping the arrangement for Pad Wide…");
    expect(progressLabel("get_arrangement", { track: 99 }, STATE)).toBe("mapping the arrangement…");
  });

  it("has a past-tense phrase beside every present one", () => {
    expect(readLabel("get_arrangement", "Pad", true)).toBe("mapped the arrangement for Pad");
    expect(readLabel("get_arrangement", null, true)).toBe("mapped the arrangement");
    expect(readLabel("get_arrangement", "Pad", false)).toBe("mapping the arrangement for Pad…");
    expect(readLabel("get_future_thing", "Pad", true)).toBe("read something");
    expect(readLabel("get_future_thing", "Pad", false)).toBe("reading…");
  });

  it("falls back when the mirror has the track but not its name yet", () => {
    expect(progressLabel("get_track_detail", { track: 2 }, STATE)).toBe("reading a track…");
  });

  it("falls back when the argument is missing or the wrong type", () => {
    expect(progressLabel("get_track_detail", {}, STATE)).toBe("reading a track…");
    expect(progressLabel("get_track_detail", { track: "1" }, STATE)).toBe("reading a track…");
    expect(progressLabel("get_track_detail", null, STATE)).toBe("reading a track…");
  });

  it("has something to say about a tool it has never heard of", () => {
    expect(progressLabel("get_future_thing", { track: 1 }, STATE)).toBe("reading…");
  });

  // The whole point of this function. A regression here puts JSON back on
  // screen, which is what it was written to remove.
  it("never leaks raw arguments or the function name", () => {
    for (const [name, args] of [
      ["get_track_detail", { track: 1 }],
      ["get_track_detail", { track: 99 }],
      ["get_clip_notes", { track: 0, clip: 2 }],
      ["get_arrangement_notes", { track: 99, index: 0 }],
      ["get_device_params", { track: 1, path: "0/1" }],
      ["get_rack_contents", { track: 1, path: "0" }],
      ["get_clips", {}],
      ["get_arrangement", {}],
      ["get_device_chains", {}],
      ["get_future_thing", { track: 1 }],
    ] as const) {
      const label = progressLabel(name, args, STATE);
      expect(label).not.toContain("{");
      expect(label).not.toContain("_");
    }
  });
});
