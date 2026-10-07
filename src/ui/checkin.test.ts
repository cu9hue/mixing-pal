import { describe, expect, it } from "vitest";
import { checkinTarget } from "./checkin";
import { Exchange } from "./thread";
import { Outcome } from "../notes/outcomes";

const x = (turnId: string, extra: Partial<Exchange> = {}): Exchange =>
  ({ question: "q", answer: "a", error: null, turnId, move: `move ${turnId}`, ...extra });
const rated = (turnId: string): Outcome =>
  ({ turnId, move: "m", outcome: "kept", heard: "", tracks: [], answer: "a", at: 1 });
const none = new Set<string>();

describe("checkinTarget", () => {
  it("asks about the newest exchange when it has an unrated move", () => {
    expect(checkinTarget([x("1"), x("2")], [], none, false)?.turnId).toBe("2");
  });
  it("asks about nothing while a turn runs", () => {
    expect(checkinTarget([x("1")], [], none, true)).toBeNull();
  });
  it("never reaches back past the newest exchange", () => {
    expect(checkinTarget([x("1"), x("2", { move: undefined })], [], none, false)).toBeNull();
  });
  it("skips a rated, set-aside, failed or anonymous newest exchange", () => {
    expect(checkinTarget([x("1")], [rated("1")], none, false)).toBeNull();
    expect(checkinTarget([x("1")], [], new Set(["1"]), false)).toBeNull();
    expect(checkinTarget([x("1", { answer: null, error: "failed" })], [], none, false)).toBeNull();
    expect(checkinTarget([x("1", { turnId: undefined })], [], none, false)).toBeNull();
    expect(checkinTarget([], [], none, false)).toBeNull();
  });
});
