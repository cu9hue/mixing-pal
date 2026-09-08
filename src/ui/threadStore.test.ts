import { describe, it, expect } from "vitest";
import { emptySet } from "../live/apply";
import { keyFor, shouldSwitch, historyFrom, recapLine, ThreadKey } from "./threadStore";

const a: ThreadKey = { id: "aaaa", path: "/x/a.als" };
const b: ThreadKey = { id: "bbbb", path: "/x/b.als" };

describe("keyFor", () => {
  it("is null until the set has an identity", () => {
    expect(keyFor(emptySet())).toBeNull();
  });

  it("carries the id and the path", () => {
    expect(keyFor({ ...emptySet(), setId: "aaaa", setPath: "/x/a.als" })).toEqual(a);
  });
});

describe("shouldSwitch", () => {
  it("switches from nothing to a set", () => {
    expect(shouldSwitch(null, a, false)).toBe(true);
  });

  it("switches from one set to another", () => {
    expect(shouldSwitch(a, b, false)).toBe(true);
  });

  it("does not switch to the set it already shows", () => {
    expect(shouldSwitch(a, { ...a }, false)).toBe(false);
  });

  // The connector gone, or an unsaved set: nothing on screen changes.
  it("never switches to no identity", () => {
    expect(shouldSwitch(a, null, false)).toBe(false);
    expect(shouldSwitch(null, null, false)).toBe(false);
  });

  // An answer can only land in the thread its question was asked in.
  it("waits for a running turn to finish", () => {
    expect(shouldSwitch(a, b, true)).toBe(false);
    expect(shouldSwitch(null, a, true)).toBe(false);
  });
});

describe("historyFrom", () => {
  it("turns answered exchanges into user and assistant turns", () => {
    expect(
      historyFrom(
        [
          { question: "q1", answer: "a1", error: null },
          { question: "q2", answer: null, error: "timed out" },
          { question: "q3", answer: "a3", error: null },
        ],
        12,
      ),
    ).toEqual([
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
    ]);
  });

  it("keeps only the most recent messages", () => {
    const exchanges = Array.from({ length: 10 }, (_, i) => ({
      question: `q${i}`,
      answer: `a${i}`,
      error: null,
    }));
    const history = historyFrom(exchanges, 4);
    expect(history.map((m) => m.content)).toEqual(["q8", "a8", "q9", "a9"]);
  });
});

describe("recapLine", () => {
  const day = 24 * 60 * 60;

  it("counts and dates the restored thread", () => {
    expect(recapLine(4, 1000, 1000 + 3 * day)).toBe("Earlier on this set · 4 exchanges · last 3 days ago");
  });

  it("says today, yesterday, and the singular", () => {
    expect(recapLine(1, 1000, 1000)).toBe("Earlier on this set · 1 exchange · last today");
    expect(recapLine(2, 1000, 1000 + day)).toBe("Earlier on this set · 2 exchanges · last yesterday");
  });

  it("never reports a negative age when clocks disagree", () => {
    expect(recapLine(1, 5000, 1000)).toBe("Earlier on this set · 1 exchange · last today");
  });
});
