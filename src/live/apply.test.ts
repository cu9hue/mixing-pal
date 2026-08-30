import { describe, it, expect } from "vitest";
import { emptySet, applyDelta, CUE_POINTS_ADDR } from "./apply";

describe("applyDelta", () => {
  it("stores song properties that carry no index", () => {
    const s = applyDelta(emptySet(), {
      addr: "/live/song/get/tempo",
      args: [128.0],
    });
    expect(s.tempo).toBe(128.0);
  });

  it("routes indexed track properties to the right track", () => {
    let s = emptySet();
    s = applyDelta(s, { addr: "/live/track/get/name", args: [0, "Kick"] });
    s = applyDelta(s, { addr: "/live/track/get/name", args: [1, "Bass"] });
    expect(s.tracks[0].name).toBe("Kick");
    expect(s.tracks[1].name).toBe("Bass");
  });

  it("does not mutate the state it was given", () => {
    const before = emptySet();
    const after = applyDelta(before, {
      addr: "/live/song/get/tempo",
      args: [140.0],
    });
    expect(before.tempo).toBeNull();
    expect(after.tempo).toBe(140.0);
  });

  it("ignores an unknown address rather than throwing", () => {
    const s = applyDelta(emptySet(), { addr: "/live/nonsense", args: [1] });
    expect(s).toEqual(emptySet());
  });

  it("stores a null meter reading as null, not 0, and does not crash", () => {
    // Rust serializes non-finite floats (NaN, Infinity) as JSON null. A null
    // meter means "unknown", not "silent" — coercing it to 0 would be a lie.
    let s = emptySet();
    s = applyDelta(s, {
      addr: "/live/track/get/output_meter_level",
      args: [0, null],
    });
    expect(s.tracks[0].meter).toBeNull();
  });

  it("routes mute, solo, and panning to the right track", () => {
    let s = emptySet();
    s = applyDelta(s, { addr: "/live/track/get/mute", args: [0, true] });
    s = applyDelta(s, { addr: "/live/track/get/solo", args: [0, false] });
    s = applyDelta(s, { addr: "/live/track/get/panning", args: [0, -0.3] });
    expect(s.tracks[0].mute).toBe(true);
    expect(s.tracks[0].solo).toBe(false);
    expect(s.tracks[0].panning).toBe(-0.3);
  });

  it("stores a null mute/solo as null, not false, and does not crash", () => {
    // Same null-tolerance rule as meter: a null arg means "unknown", and
    // coercing it to false would claim the track is definitely not muted.
    let s = emptySet();
    s = applyDelta(s, { addr: "/live/track/get/mute", args: [0, null] });
    s = applyDelta(s, { addr: "/live/track/get/solo", args: [0, null] });
    expect(s.tracks[0].mute).toBeNull();
    expect(s.tracks[0].solo).toBeNull();
  });

  describe("num_tracks", () => {
    // Regression for F2 (2026-08-16 whole-branch review): Rust's
    // Coalescer::evict_tracks_at_or_beyond already cleans its own maps when
    // a track is deleted in Live, but emitted no delta -- applyDelta only
    // ever inserted into state.tracks, so a deleted track's row stayed in
    // the window forever, showing whatever it last read.
    function withTracks(indices: number[]): ReturnType<typeof emptySet> {
      let s = emptySet();
      for (const i of indices) {
        s = applyDelta(s, { addr: "/live/track/get/name", args: [i, `Track ${i}`] });
      }
      return s;
    }

    it("removes tracks at or beyond a shrunk count", () => {
      let s = withTracks([0, 1, 2, 3, 4, 5]);
      s = applyDelta(s, { addr: "/live/song/get/num_tracks", args: [5] });
      expect(Object.keys(s.tracks).map(Number).sort((a, b) => a - b)).toEqual([
        0, 1, 2, 3, 4,
      ]);
    });

    it("does not remove any track when the count grows", () => {
      let s = withTracks([0, 1, 2]);
      s = applyDelta(s, { addr: "/live/song/get/num_tracks", args: [10] });
      expect(Object.keys(s.tracks).map(Number).sort((a, b) => a - b)).toEqual([
        0, 1, 2,
      ]);
    });

    it("ignores a null count rather than wiping the table", () => {
      let s = withTracks([0, 1, 2]);
      s = applyDelta(s, { addr: "/live/song/get/num_tracks", args: [null] });
      expect(Object.keys(s.tracks).map(Number).sort((a, b) => a - b)).toEqual([
        0, 1, 2,
      ]);
    });
  });

  it("maps a cue point reply into pairs behind its total", () => {
    const state = applyDelta(emptySet(), {
      addr: CUE_POINTS_ADDR,
      args: [2, "Intro", 0, "Drop", 64],
    });
    expect(state.cuePoints).toEqual([
      { name: "Intro", time: 0 },
      { name: "Drop", time: 64 },
    ]);
    expect(state.cuePointsTotal).toBe(2);
  });

  it("keeps the true total when the reply carried only a prefix", () => {
    // The connector cuts the reply to one datagram. Without the total, the
    // digest would present the prefix as the whole arrangement.
    const state = applyDelta(emptySet(), {
      addr: CUE_POINTS_ADDR,
      args: [400, "Intro", 0],
    });
    expect(state.cuePoints).toEqual([{ name: "Intro", time: 0 }]);
    expect(state.cuePointsTotal).toBe(400);
  });

  it("reports a set with no locators as empty rather than unknown", () => {
    const state = applyDelta(emptySet(), { addr: CUE_POINTS_ADDR, args: [0] });
    expect(state.cuePoints).toEqual([]);
    expect(state.cuePointsTotal).toBe(0);
  });

  it("ignores a ragged cue point reply rather than half-applying it", () => {
    // A trailing name with no time would misplace every section after it.
    const before = { ...emptySet(), cuePoints: [{ name: "Intro", time: 0 }] };
    const after = applyDelta(before, {
      addr: CUE_POINTS_ADDR,
      args: [2, "Intro", 0, "Drop"],
    });
    expect(after.cuePoints).toEqual(before.cuePoints);
  });

  it("ignores a reply whose leading total is missing", () => {
    // Reading the old shape -- pairs with no total -- would take "Intro" for
    // a count and shift every locator by one field.
    const before = { ...emptySet(), cuePoints: [{ name: "Intro", time: 0 }] };
    const after = applyDelta(before, {
      addr: CUE_POINTS_ADDR,
      args: ["Intro", 0, "Drop", 64],
    });
    expect(after.cuePoints).toEqual(before.cuePoints);
  });
});
