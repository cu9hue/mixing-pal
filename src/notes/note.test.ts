import { describe, expect, it } from "vitest";
import {
  BULLET_MAX_CHARS,
  NOTE_MAX_BULLETS,
  Note,
  addBullet,
  ageWords,
  deleteBullet,
  editBullet,
  emptyNote,
  mergeNote,
  noteDelta,
  normalise,
} from "./note";

const NOW = 1_000_000;
const DAY = 24 * 60 * 60;

function noteWith(...texts: string[]): Note {
  let n = emptyNote();
  for (const t of texts) n = addBullet(n, "move", t, false, NOW);
  return n;
}

describe("noteDelta", () => {
  it("leaves an answer with no block alone", () => {
    expect(noteDelta("Try a high-pass.")).toEqual({
      answer: "Try a high-pass.",
      delta: { adds: [], retires: [] },
    });
  });

  it("strips the block and reads adds and retires", () => {
    const out = noteDelta(
      "Try a high-pass near 180 Hz.\n\n```note\n+ move low end: high-pass «Pad Wide» near 180 Hz\n- b3\n```",
    );
    expect(out.answer).toBe("Try a high-pass near 180 Hz.");
    expect(out.delta).toEqual({
      adds: [{ kind: "move", text: "low end: high-pass «Pad Wide» near 180 Hz" }],
      retires: ["b3"],
    });
  });

  it("ignores lines that are not a change, an unknown kind, and an empty text", () => {
    const out = noteDelta("x\n```note\nhello\n+ advice do this\n+ move   \n- nope\n- b12\n```");
    expect(out.delta).toEqual({ adds: [], retires: ["b12"] });
  });

  // The model is told to write one block; if it writes two, the last is
  // its final word, and neither reaches the producer as text.
  it("applies only the last block and strips every block", () => {
    const out = noteDelta("a\n```note\n+ move first\n```\nb\n```note\n+ move second\n```");
    expect(out.answer).toBe("a\n\nb");
    expect(out.delta.adds).toEqual([{ kind: "move", text: "second" }]);
  });

  it("treats an unclosed block as text", () => {
    const text = "a\n```note\n+ move first";
    expect(noteDelta(text)).toEqual({ answer: text, delta: { adds: [], retires: [] } });
  });

  it("parses and strips a CRLF block", () => {
    const out = noteDelta("y\r\n```note\r\n+ move a\r\n```");
    expect(out.answer).toBe("y");
    expect(out.delta).toEqual({ adds: [{ kind: "move", text: "a" }], retires: [] });
  });

  it("strips an empty block with an empty delta", () => {
    const out = noteDelta("y\n```note\n```");
    expect(out.answer).toBe("y");
    expect(out.delta).toEqual({ adds: [], retires: [] });
  });

  it("keeps only the first two accepted changes, adds and retires sharing one budget", () => {
    const three = noteDelta("x\n```note\n+ move a\n+ move b\n+ move c\n```");
    expect(three.delta.adds).toEqual([
      { kind: "move", text: "a" },
      { kind: "move", text: "b" },
    ]);

    const mixed = noteDelta("x\n```note\n+ move a\n- b0\n- b1\n```");
    expect(mixed.delta).toEqual({ adds: [{ kind: "move", text: "a" }], retires: ["b0"] });
  });
});

describe("normalise", () => {
  it("folds case, punctuation, and whitespace", () => {
    expect(normalise("  High-pass  the PAD, near 180Hz! ")).toBe("high pass the pad near 180hz");
  });
});

describe("mergeNote", () => {
  it("adds model bullets with fresh ids and hers false", () => {
    const n = mergeNote(emptyNote(), { adds: [{ kind: "move", text: "a" }], retires: [] }, NOW);
    expect(n.bullets).toEqual([{ id: "b0", kind: "move", text: "a", at: NOW, hers: false }]);
    expect(n.next).toBe(1);
  });

  it("drops an add whose normalised text already exists", () => {
    const n = mergeNote(noteWith("High-pass the pad"), { adds: [{ kind: "heard", text: "high pass the pad." }], retires: [] }, NOW);
    expect(n.bullets).toHaveLength(1);
  });

  it("caps an add at BULLET_MAX_CHARS", () => {
    const n = mergeNote(emptyNote(), { adds: [{ kind: "move", text: "x".repeat(300) }], retires: [] }, NOW);
    expect(n.bullets[0].text).toHaveLength(BULLET_MAX_CHARS);
  });

  it("retires a model bullet and ignores an unknown id", () => {
    const n = mergeNote(noteWith("a", "b"), { adds: [], retires: ["b0", "b9"] }, NOW);
    expect(n.bullets.map((b) => b.text)).toEqual(["b"]);
  });

  it("refuses to retire hers", () => {
    const hers = addBullet(emptyNote(), "heard", "mine", true, NOW);
    const n = mergeNote(hers, { adds: [], retires: ["b0"] }, NOW);
    expect(n.bullets).toHaveLength(1);
  });

  it("caps at NOTE_MAX_BULLETS by dropping the oldest model bullet, never hers", () => {
    let n = addBullet(emptyNote(), "decided", "hers first", true, NOW - 10 * DAY);
    for (let i = 0; i < NOTE_MAX_BULLETS; i++) n = addBullet(n, "move", `m${i}`, false, NOW - (NOTE_MAX_BULLETS - i) * DAY);
    n = mergeNote(n, { adds: [{ kind: "move", text: "newest" }], retires: [] }, NOW);
    expect(n.bullets).toHaveLength(NOTE_MAX_BULLETS);
    expect(n.bullets[0].text).toBe("hers first");
    expect(n.bullets.some((b) => b.text === "m0")).toBe(false);
    expect(n.bullets[n.bullets.length - 1].text).toBe("newest");
  });
});

describe("addBullet", () => {
  it("splits on code points, not UTF-16 units, so a trailing surrogate pair survives the cap", () => {
    const n = addBullet(emptyNote(), "move", "a".repeat(159) + "🔥", false, NOW);
    expect(Array.from(n.bullets[0].text)).toHaveLength(BULLET_MAX_CHARS);
    expect(n.bullets[0].text.endsWith("🔥")).toBe(true);
  });

  it("caps at NOTE_MAX_BULLETS, keeping hers and dropping the oldest model bullet", () => {
    let n = emptyNote();
    for (let i = 0; i < NOTE_MAX_BULLETS; i++) n = addBullet(n, "move", `m${i}`, false, NOW - (NOTE_MAX_BULLETS - i) * DAY);
    n = addBullet(n, "heard", "hers", true, NOW);
    expect(n.bullets).toHaveLength(NOTE_MAX_BULLETS);
    expect(n.bullets.some((b) => b.text === "hers")).toBe(true);
    expect(n.bullets.some((b) => b.text === "m0")).toBe(false);
  });

  it("a her add that duplicates a model bullet promotes it to hers, keeping id, kind, text, and at", () => {
    let n = addBullet(emptyNote(), "move", "high-pass the pad", false, NOW);
    n = addBullet(n, "move", "High-pass the pad.", true, NOW + 5);
    expect(n.bullets).toEqual([{ id: "b0", kind: "move", text: "high-pass the pad", at: NOW, hers: true }]);
  });

  it("a model add that duplicates a model bullet leaves it unchanged", () => {
    let n = addBullet(emptyNote(), "move", "high-pass the pad", false, NOW);
    n = addBullet(n, "move", "High-pass the pad.", false, NOW + 5);
    expect(n.bullets).toEqual([{ id: "b0", kind: "move", text: "high-pass the pad", at: NOW, hers: false }]);
  });
});

describe("her edits", () => {
  it("her edit marks the bullet hers and moves its time", () => {
    const n = editBullet(noteWith("a"), "b0", "a, revised", NOW + 5);
    expect(n.bullets[0]).toEqual({ id: "b0", kind: "move", text: "a, revised", at: NOW + 5, hers: true });
  });

  it("her edit splits on code points, not UTF-16 units, so a trailing surrogate pair survives the cap", () => {
    const n = editBullet(noteWith("a"), "b0", "a".repeat(159) + "🔥", NOW + 5);
    expect(Array.from(n.bullets[0].text)).toHaveLength(BULLET_MAX_CHARS);
    expect(n.bullets[0].text.endsWith("🔥")).toBe(true);
  });

  it("her edit with emptied text deletes the bullet", () => {
    const n = editBullet(noteWith("a"), "b0", "   ", NOW + 5);
    expect(n.bullets).toEqual([]);
  });

  it("her delete removes any bullet", () => {
    const hers = addBullet(emptyNote(), "heard", "mine", true, NOW);
    expect(deleteBullet(hers, "b0").bullets).toEqual([]);
  });

  it("her add is hers and de-duplicated too", () => {
    let n = addBullet(emptyNote(), "move", "a", true, NOW);
    n = addBullet(n, "move", "A.", true, NOW);
    expect(n.bullets).toHaveLength(1);
    expect(n.bullets[0].hers).toBe(true);
  });
});

describe("ageWords", () => {
  it("says today, yesterday, and days ago, never a negative", () => {
    expect(ageWords(NOW, NOW)).toBe("today");
    expect(ageWords(NOW - DAY, NOW)).toBe("yesterday");
    expect(ageWords(NOW - 3 * DAY, NOW)).toBe("3 days ago");
    expect(ageWords(NOW + DAY, NOW)).toBe("today");
  });
});
