import { describe, it, expect } from "vitest";
import { emptySet } from "../live/apply";
import { keyFor, classify, historyFrom, recapLine, carryNote, ThreadKey } from "./threadStore";
import { addBullet, emptyNote } from "../notes/note";

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

describe("classify", () => {
  it("switches from nothing to a set", () => {
    expect(classify(null, a, false)).toBe("switch");
  });

  it("switches from one set to another", () => {
    expect(classify(a, b, false)).toBe("switch");
  });

  it("does nothing for the set it already shows", () => {
    expect(classify(a, { ...a }, false)).toBe("none");
  });

  // Every new set goes from its path to a stored id a poll or two after
  // it opens. Same set, same thread, new key.
  it("rekeys the promotion from path to stored id", () => {
    const byPath: ThreadKey = { id: "/x/a.als", path: "/x/a.als" };
    expect(classify(byPath, a, false)).toBe("rekey");
  });

  // Save As or a move keeps the stored id and changes the path.
  it("rekeys a save-as under the same id", () => {
    expect(classify(a, { id: "aaaa", path: "/y/a v2.als" }, false)).toBe("rekey");
  });

  // Two unsaved sets have no path; a new id with no path in common is
  // another set, not a promotion.
  it("does not treat two pathless sets as one", () => {
    expect(classify({ id: "x", path: null }, { id: "y", path: null }, false)).toBe("switch");
  });

  // The connector gone, or an unsaved set: nothing on screen changes.
  it("never switches to no identity", () => {
    expect(classify(a, null, false)).toBe("none");
    expect(classify(null, null, false)).toBe("none");
  });

  // An answer can only land in the thread its question was asked in.
  it("waits for a running turn to finish", () => {
    expect(classify(a, b, true)).toBe("none");
    expect(classify(null, a, true)).toBe("none");
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

describe("carryNote", () => {
  const saved = { note: [{ id: "b3", kind: "move" as const, text: "kept", at: 10, hers: false }], next_bullet: 4 };

  it("restores the saved note untouched on an ordinary switch", () => {
    const current = addBullet(emptyNote(), "heard", "mine", true, 20);
    expect(carryNote(saved, current, false)).toEqual({ note: { bullets: saved.note, next: 4 }, carried: false });
  });

  it("folds pre-identity bullets into the first set's note, keeping stored ids and hers", () => {
    const current = addBullet(emptyNote(), "heard", "mine", true, 20);
    const out = carryNote(saved, current, true);
    expect(out.carried).toBe(true);
    expect(out.note.bullets).toEqual([
      { id: "b3", kind: "move", text: "kept", at: 10, hers: false },
      { id: "b4", kind: "heard", text: "mine", at: 20, hers: true },
    ]);
    expect(out.note.next).toBe(5);
  });

  it("carries nothing when there was nothing on screen, even on the first key", () => {
    expect(carryNote(null, emptyNote(), true)).toEqual({ note: emptyNote(), carried: false });
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
