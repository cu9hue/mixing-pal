import { describe, expect, it } from "vitest";
import { buildContext } from "./build";
import { SetState, TrackState } from "../live/model";
import evalFixture from "../../shared/eval-set.json";
import evalContext from "../../shared/eval-context.txt?raw";
import craftFixture from "../../shared/craft-set.json";
import craftContext from "../../shared/craft-context.txt?raw";
import oneshotFixture from "../../shared/oneshot-set.json";
import oneshotContext from "../../shared/oneshot-context.txt?raw";

// Each fixture is one eval suite's set, and Rust builds its fake Live from
// the same file. Rust cannot call buildContext, so the rendered digest is
// checked in beside it and pinned here -- the same two-language pinning
// shared/wire-version.json already uses.
interface EvalFixture {
  goal: string;
  song: Omit<SetState, "tracks">;
  tracks: Array<{ name: string; mute: boolean; solo: boolean; volumeDb: string }>;
}

function fixtureState(fixture: EvalFixture): SetState {
  const tracks: Record<number, TrackState> = {};
  fixture.tracks.forEach((t, i) => {
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

describe.each([
  ["eval-set.json", evalFixture, evalContext],
  ["craft-set.json", craftFixture, craftContext],
  ["oneshot-set.json", oneshotFixture, oneshotContext],
])("the fixture %s", (_name, fixture, context) => {
  it("renders to the checked-in context block", () => {
    const expected = context.replace(/\n$/, "");
    expect(buildContext(fixtureState(fixture), fixture.goal)).toBe(expected);
  });
});
