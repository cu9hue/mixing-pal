import { describe, it, expect } from "vitest";
import { waitingLabel, SLOW_AFTER_MS } from "./waitingLabel";

const RUNNING = { busy: true, toolProgress: null, elapsedMs: 0 };

describe("waitingLabel", () => {
  it("says nothing when no turn is running", () => {
    expect(waitingLabel({ ...RUNNING, busy: false })).toBeNull();
  });

  // A label left over from a finished turn is the bug this replaces: the card
  // went on claiming to be reading a track after the answer had arrived.
  it("says nothing once the turn ends, even mid-tool", () => {
    expect(
      waitingLabel({ busy: false, toolProgress: "reading Pad Wide…", elapsedMs: 3_000 }),
    ).toBeNull();
  });

  it("shows Thinking as soon as a turn starts", () => {
    expect(waitingLabel(RUNNING)).toBe("Thinking…");
  });

  // The tool line names her music; it is strictly more informative than
  // "Thinking…" and must win for as long as the tool is actually running.
  it("prefers the tool line while a tool is running", () => {
    expect(waitingLabel({ ...RUNNING, toolProgress: "reading Pad Wide…" })).toBe(
      "reading Pad Wide…",
    );
  });

  it("keeps preferring the tool line even once the turn is slow", () => {
    expect(
      waitingLabel({ busy: true, toolProgress: "reading Pad Wide…", elapsedMs: 30_000 }),
    ).toBe("reading Pad Wide…");
  });

  it("stays quiet about timing until the turn has been slow", () => {
    expect(waitingLabel({ ...RUNNING, elapsedMs: SLOW_AFTER_MS - 1 })).toBe("Thinking…");
  });

  it("admits the elapsed time once the turn is slow", () => {
    expect(waitingLabel({ ...RUNNING, elapsedMs: SLOW_AFTER_MS })).toBe("Thinking… 10s");
  });

  // Whole seconds only. A counter ticking tenths in the corner of someone's
  // eye is exactly the kind of motion the design forbids.
  it("floors the elapsed seconds", () => {
    expect(waitingLabel({ ...RUNNING, elapsedMs: 14_900 })).toBe("Thinking… 14s");
  });

  it("waits ten seconds before mentioning time", () => {
    expect(SLOW_AFTER_MS).toBe(10_000);
  });
});
