import { describe, it, expect } from "vitest";
import { summaryLine } from "./summaryLine";
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
