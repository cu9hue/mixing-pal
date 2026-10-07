import { describe, expect, it } from "vitest";
import { Note, emptyNote } from "../notes/note";
import { Outcome } from "../notes/outcomes";
import { BREAK_SECONDS, recapFor } from "./recap";
import { Exchange } from "./thread";

const HOUR = 60 * 60;
const DAY = 24 * HOUR;
const SAVED = 1_000_000;

const ask = (question: string, turnId?: string): Exchange => ({ question, answer: "An answer.", error: null, ...(turnId ? { turnId } : {}) });
const rated = (turnId: string, outcome: "kept" | "undone", at: number, heard = ""): Outcome =>
  ({ turnId, move: `move ${turnId}`, outcome, heard, tracks: [], answer: "", at });
const note = (...bullets: [Note["bullets"][number]["kind"], string, number][]): Note =>
  ({ bullets: bullets.map(([kind, text, at], i) => ({ id: `b${i}`, kind, text, at, hers: false })), next: bullets.length });

describe("recapFor", () => {
  it("is null before the break", () => {
    expect(recapFor([ask("q")], [], emptyNote(), SAVED, SAVED + BREAK_SECONDS - 1)).toBeNull();
  });

  it("is null for a set with no thread", () => {
    expect(recapFor([], [], emptyNote(), SAVED, SAVED + DAY)).toBeNull();
  });

  it("names when, and the last question she asked", () => {
    const recap = recapFor([ask("first"), ask("What should I work on next?")], [], emptyNote(), SAVED, SAVED + 2 * DAY);
    expect(recap).toEqual({ when: "2 days ago", asked: "What should I work on next?", rated: [], decided: [] });
  });

  it("says earlier today for a break inside the same day", () => {
    expect(recapFor([ask("q")], [], emptyNote(), SAVED, SAVED + BREAK_SECONDS)?.when).toBe("earlier today");
  });

  it("lists the newest three rated moves, each at its latest rating, with what she heard", () => {
    const log = [
      rated("a", "kept", 1), rated("b", "kept", 2), rated("c", "undone", 3, "too pumpy"),
      rated("d", "kept", 4, "tighter"), rated("b", "undone", 5),
    ];
    expect(recapFor([ask("q")], log, emptyNote(), SAVED, SAVED + DAY)?.rated).toEqual([
      { outcome: "undone", move: "move b", heard: "" },
      { outcome: "kept", move: "move d", heard: "tighter" },
      { outcome: "undone", move: "move c", heard: "too pumpy" },
    ]);
  });

  it("lists the newest two decided bullets and nothing else from the note", () => {
    const n = note(["decided", "Keep the vocal dry", 3], ["move", "Cut 200 Hz", 9], ["decided", "Old call", 1], ["decided", "Drop at bar 33", 5], ["heard", "Muddy", 8]);
    expect(recapFor([ask("q")], [], n, SAVED, SAVED + DAY)?.decided).toEqual(["Drop at bar 33", "Keep the vocal dry"]);
  });
});
