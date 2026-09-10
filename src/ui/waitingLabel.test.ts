import { describe, it, expect } from "vitest";
import { waitingLabel, SLOW_AFTER_MS } from "./waitingLabel";

const RUNNING = { busy: true, toolProgress: null, toolsCalled: 0, elapsedMs: 0 };

describe("waitingLabel", () => {
  it("says nothing when no turn is running", () => {
    expect(waitingLabel({ ...RUNNING, busy: false })).toBeNull();
  });

  // A label left over from a finished turn is the bug this replaces: the card
  // went on claiming to be reading a track after the answer had arrived.
  it("says nothing once the turn ends, even mid-tool", () => {
    expect(
      waitingLabel({ busy: false, toolProgress: "reading Pad Wide…", toolsCalled: 1, elapsedMs: 3_000 }),
    ).toBeNull();
  });

  it("shows Thinking as soon as a turn starts", () => {
    expect(waitingLabel(RUNNING)).toBe("Thinking…");
  });

  // The tool line names her music; it is strictly more informative than
  // "Thinking…" and must win for as long as the tool is actually running.
  it("prefers the tool line while a tool is running", () => {
    expect(waitingLabel({ ...RUNNING, toolProgress: "reading Pad Wide…", toolsCalled: 1 })).toBe(
      "reading Pad Wide…",
    );
  });

  // The first read is just the tool line; from the second on she can see
  // the turn is a sequence, and how long a one.
  it("counts the reads on the tool line from the second read on", () => {
    expect(waitingLabel({ ...RUNNING, toolProgress: "reading Pad Wide…", toolsCalled: 3 })).toBe(
      "reading Pad Wide… · 3 reads",
    );
  });

  it("says how many reads are behind the thinking, once there are any", () => {
    expect(waitingLabel({ ...RUNNING, toolsCalled: 1 })).toBe("Thinking… 1 read so far");
    expect(waitingLabel({ ...RUNNING, toolsCalled: 4 })).toBe("Thinking… 4 reads so far");
    expect(waitingLabel({ ...RUNNING, toolsCalled: 4, elapsedMs: 12_000 })).toBe(
      "Thinking… 4 reads so far · 12s",
    );
  });

  it("keeps preferring the tool line even once the turn is slow", () => {
    expect(
      waitingLabel({ busy: true, toolProgress: "reading Pad Wide…", toolsCalled: 1, elapsedMs: 30_000 }),
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
