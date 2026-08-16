import { describe, it, expect } from "vitest";
import { emptySet, applyDelta } from "./apply";

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
});
