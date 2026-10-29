import { describe, expect, it } from "vitest";
import { emptySet } from "../live/apply";
import { SetState, TrackState } from "../live/model";
import { starterQuestions } from "./examples";

function set(names: (string | null)[], extra: Partial<SetState> = {}): SetState {
  const tracks = Object.fromEntries(names.map((name, i) => [i, { name } as TrackState]));
  return { ...emptySet(), tracks, ...extra };
}
const cue = (name: string, time: number) => ({ name, time });

describe("starter questions", () => {
  it("fall back to plain forms for an empty set", () => {
    expect(starterQuestions(emptySet())).toEqual([
      "What comes in when in the first 16 bars?",
      "What's on the selected track's chain, and what would you try?",
      "I'm stuck at 8 bars. How do I turn this into a full track?",
    ]);
  });

  it("use the first section after the start and the selected track", () => {
    const s = set(["Pad", "Drums"], { selectedTrack: 0, cuePoints: [cue("Intro", 0), cue("Drop", 64)] });
    expect(starterQuestions(s)).toEqual([
      "What plays in Drop, and what's missing?",
      "What's on the Pad chain, and what would you try?",
      "What should I work on next to finish this track?",
    ]);
  });

  it("use the only locator even at the start, and sort locators by time", () => {
    expect(starterQuestions(set([], { cuePoints: [cue("Intro", 0)] }))[0]).toBe("What plays in Intro, and what's missing?");
    expect(starterQuestions(set([], { cuePoints: [cue("Drop", 64), cue("Break", 32)] }))[0]).toBe("What plays in Break, and what's missing?");
  });

  it("skip unnamed locators but still treat the set as arranged", () => {
    const q = starterQuestions(set([], { cuePoints: [cue("", 32), cue("  ", 64)] }));
    expect(q[0]).toBe("What comes in when in the first 16 bars?");
    expect(q[2]).toBe("What should I work on next to finish this track?");
  });

  it("skip Live's default track names", () => {
    const s = set(["1 MIDI", "2-Audio", "3 Audio", "Vox"], { selectedTrack: 1 });
    expect(starterQuestions(s)[1]).toBe("What's on the Vox chain, and what would you try?");
    expect(starterQuestions(set(["12 MIDI", "", null]))[1]).toBe("What's on the selected track's chain, and what would you try?");
    expect(starterQuestions(set(["Audio Bus"]))[1]).toBe("What's on the Audio Bus chain, and what would you try?");
  });

  it("fall back to the first real name when the selected track is gone", () => {
    expect(starterQuestions(set(["Pad", "Drums"], { selectedTrack: 7 }))[1]).toBe("What's on the Pad chain, and what would you try?");
  });

  it("keep a long or unusual name as the producer typed it", () => {
    expect(starterQuestions(set(["Pad (old) v2 FINAL"], { selectedTrack: 0 }))[1])
      .toBe("What's on the Pad (old) v2 FINAL chain, and what would you try?");
  });
});
