import { describe, it, expect } from "vitest";
import { progressLabel } from "./progressLabel";
import { SetState } from "../live/model";
import { emptyTrack } from "../live/model";

const STATE: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: "Minor",
  rootNote: 9,
  selectedTrack: 1,
  scriptVersion: 2,
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
      ["get_future_thing", { track: 1 }],
    ] as const) {
      const label = progressLabel(name, args, STATE);
      expect(label).not.toContain("{");
      expect(label).not.toContain("_");
    }
  });
});
