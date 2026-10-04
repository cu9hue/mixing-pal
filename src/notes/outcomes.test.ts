import { describe, expect, it } from "vitest";
import { emptySet } from "../live/apply";
import { emptyTrack } from "../live/model";
import { OUTCOME_TEXT_MAX_CHARS, Outcome, clear, latestFor, rate, recentOutcomes, setHeard, withTrackRead } from "./outcomes";

const ex = (turnId: string) => ({ turnId, move: `move ${turnId}`, answer: `answer ${turnId}`, tracksRead: ["Pad"] });

describe("the outcome log", () => {
  it("appends a record with the move, tracks, answer and an empty heard", () => {
    const log = rate([], ex("t1"), "kept", 100);
    expect(log).toEqual([{ turnId: "t1", move: "move t1", outcome: "kept", heard: "", tracks: ["Pad"], answer: "answer t1", at: 100 }]);
  });

  it("cuts a long answer", () => {
    const log = rate([], { ...ex("t1"), answer: "a".repeat(OUTCOME_TEXT_MAX_CHARS + 5) }, "kept", 1);
    expect(log[0].answer).toHaveLength(OUTCOME_TEXT_MAX_CHARS);
  });

  it("rate then clear returns to the earlier rating", () => {
    let log = rate([], ex("t1"), "kept", 1);
    log = rate(log, ex("t1"), "undone", 2);
    log = clear(log, "t1");
    expect(latestFor(log, "t1")?.outcome).toBe("kept");
    expect(log).toHaveLength(1);
  });

  it("clear touches only the latest record of that turn", () => {
    let log = rate([], ex("t1"), "kept", 1);
    log = rate(log, ex("t2"), "undone", 2);
    log = clear(log, "t1");
    expect(log.map((o) => o.turnId)).toEqual(["t2"]);
  });

  it("setHeard edits the latest record of that turn and cuts long text", () => {
    let log = rate([], ex("t1"), "kept", 1);
    log = rate(log, ex("t1"), "undone", 2);
    log = setHeard(log, "t1", "  thin  ");
    expect(log.map((o) => o.heard)).toEqual(["", "thin"]);
    expect(setHeard(log, "t1", "h".repeat(OUTCOME_TEXT_MAX_CHARS + 1))[1].heard).toHaveLength(OUTCOME_TEXT_MAX_CHARS);
  });

  it("latestFor is null for a turn with no records", () => {
    expect(latestFor([], "t1")).toBeNull();
  });
});

describe("the recent view", () => {
  it("shows one line per answer, newest first, with the rating before the latest when it flipped", () => {
    let log: Outcome[] = rate([], ex("a"), "kept", 1);
    log = rate(log, ex("b"), "undone", 2);
    log = rate(log, ex("a"), "undone", 3);
    expect(recentOutcomes(log, 6).map(({ record, before }) => [record.turnId, record.outcome, before])).toEqual([
      ["a", "undone", "kept"],
      ["b", "undone", null],
    ]);
  });

  it("names an undo between two keeps", () => {
    let log: Outcome[] = rate([], ex("a"), "kept", 1);
    log = rate(log, ex("a"), "undone", 2);
    log = rate(log, ex("a"), "kept", 3);
    expect(recentOutcomes(log, 6).map(({ record, before }) => [record.outcome, before])).toEqual([["kept", "undone"]]);
  });

  it("caps the number of answers", () => {
    let log: Outcome[] = [];
    for (let i = 0; i < 8; i++) log = rate(log, ex(`t${i}`), "kept", i);
    expect(recentOutcomes(log, 6).map(({ record }) => record.turnId)).toEqual(["t7", "t6", "t5", "t4", "t3", "t2"]);
  });

  it("orders records with the same time by their place in the log", () => {
    let log = rate([], ex("a"), "kept", 5);
    log = rate(log, ex("b"), "kept", 5);
    expect(recentOutcomes(log, 6)[0].record.turnId).toBe("b");
  });
});

describe("the tracks a turn read", () => {
  const state = { ...emptySet(), tracks: { 0: { ...emptyTrack(), name: "Kick" }, 2: { ...emptyTrack(), name: "Pad" } } };

  it("adds a track's name once, in first-read order", () => {
    let t = withTrackRead([], { track: 2 }, state);
    t = withTrackRead(t, { track: 0 }, state);
    t = withTrackRead(t, { track: 2 }, state);
    expect(t).toEqual(["Pad", "Kick"]);
  });

  it("ignores reads with no track or an unknown one", () => {
    expect(withTrackRead([], {}, state)).toEqual([]);
    expect(withTrackRead([], { track: 9 }, state)).toEqual([]);
    expect(withTrackRead([], null, state)).toEqual([]);
  });
});
