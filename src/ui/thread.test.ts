import { describe, it, expect } from "vitest";
import { Exchange, begin, complete, fail } from "./thread";

const EARLIER: Exchange = { question: "why does the pad feel in the way", answer: "Its Auto Filter is open.", error: null };

describe("the thread", () => {
  it("begins an exchange with a question and nothing else", () => {
    expect(begin([], "the pad chords, keep or change?")).toEqual([
      { question: "the pad chords, keep or change?", answer: null, error: null },
    ]);
  });

  // Every earlier exchange stays. The thread is the whole session, not the
  // window the model is sent.
  it("appends after the earlier exchanges", () => {
    expect(begin([EARLIER], "and the bass?")).toEqual([
      EARLIER,
      { question: "and the bass?", answer: null, error: null },
    ]);
  });

  it("keeps the move label and the tracks read with the answer", () => {
    const thread = begin([], "why is the pad muddy?", "t1");
    expect(complete(thread, "Cut it.", { move: "«Pad», mud: cut", tracksRead: ["Pad"] })[0]).toEqual({
      question: "why is the pad muddy?", answer: "Cut it.", error: null, turnId: "t1", move: "«Pad», mud: cut", tracksRead: ["Pad"],
    });
  });

  it("completes the newest exchange with the answer", () => {
    const thread = begin([EARLIER], "and the bass?");
    expect(complete(thread, "Leave it.")).toEqual([
      EARLIER,
      { question: "and the bass?", answer: "Leave it.", error: null },
    ]);
  });

  // A failed turn keeps its place: the question she asked and what went
  // wrong, where the answer would have been.
  it("fails the newest exchange with the error", () => {
    const thread = begin([EARLIER], "and the bass?");
    expect(fail(thread, "timed out")).toEqual([
      EARLIER,
      { question: "and the bass?", answer: null, error: "timed out" },
    ]);
  });

  it("does not touch the earlier exchanges when completing", () => {
    const thread = begin([EARLIER], "and the bass?");
    expect(complete(thread, "Leave it.")[0]).toBe(EARLIER);
  });
});
