import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildContext } from "./build";
import { SetState, TrackState } from "../live/model";

// The fixture is the eval suite's set, and Rust builds its fake Live from
// the same file. Rust cannot call buildContext, so the rendered digest is
// checked in beside it and pinned here -- the same two-language pinning
// shared/wire-version.json already uses.
export function fixtureState(fixture: any): SetState {
  const tracks: Record<number, TrackState> = {};
  fixture.tracks.forEach((t: any, i: number) => {
    tracks[i] = {
      name: t.name,
      mute: t.mute,
      solo: t.solo,
      volume: null,
      volumeDb: t.volumeDb,
      panning: null,
      meter: null,
    };
  });
  return { ...fixture.song, tracks };
}

describe("the eval fixture", () => {
  it("renders to the checked-in context block", () => {
    const fixture = JSON.parse(readFileSync("shared/eval-set.json", "utf8"));
    const expected = readFileSync("shared/eval-context.txt", "utf8").replace(/\n$/, "");
    expect(buildContext(fixtureState(fixture), fixture.goal)).toBe(expected);
  });
});
