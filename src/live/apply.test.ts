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
});
