import { describe, it, expect } from "vitest";
import { summaryLine, setLine } from "./summaryLine";
import { SetState } from "../live/model";

const BASE: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: "Minor",
  rootNote: 9,
  signatureNumerator: null,
  signatureDenominator: null,
  selectedTrack: null,
  scriptVersion: 2,
  cuePoints: [],
  cuePointsTotal: null,
  setId: null,
  setName: null,
  setPath: null,
  tracks: {},
};

describe("summaryLine", () => {
  it("reads tempo, key, and count", () => {
    expect(summaryLine(BASE, 12)).toBe("12 tracks · 128 BPM · A Minor");
  });

  it("says a track in the singular", () => {
    expect(summaryLine(BASE, 1)).toBe("1 track · 128 BPM · A Minor");
  });

  // Same honest-unknown wording as the digest's SET line. "0 BPM" would be
  // a claim; "tempo unknown" is the truth.
  it("says tempo unknown rather than inventing a number", () => {
    expect(summaryLine({ ...BASE, tempo: null }, 12)).toBe("12 tracks · tempo unknown · A Minor");
  });

  it("says no key set rather than guessing one", () => {
    expect(summaryLine({ ...BASE, scaleName: null }, 12)).toBe("12 tracks · 128 BPM · no key set");
  });

  it("says no key set when the scale name is empty", () => {
    expect(summaryLine({ ...BASE, scaleName: "" }, 12)).toBe("12 tracks · 128 BPM · no key set");
  });
});

describe("setLine", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("names the set", () => {
    expect(setLine({ ...BASE, setId: id, setName: "Track", setPath: "/x/Track.als" })).toBe(
      "Set  Track",
    );
  });

  // The one place she can see that a thread for this set will not follow a
  // rename: the id is the path, or there is none.
  it("says when the set has no stored id", () => {
    expect(
      setLine({ ...BASE, setId: "/x/Track.als", setName: "Track", setPath: "/x/Track.als" }),
    ).toBe("Set  Track · no stored id");
    expect(setLine({ ...BASE, setId: null, setName: "Track", setPath: null })).toBe(
      "Set  Track · no stored id",
    );
  });

  it("is absent until the first reply names the set", () => {
    expect(setLine(BASE)).toBeNull();
  });
});
