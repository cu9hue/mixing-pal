import { describe, expect, it } from "vitest";
import { MAX_TERMS, TERM_LINE_MAX_CHARS, termsList } from "./terms";

const block = (...lines: string[]) => "```terms\n" + lines.join("\n") + "\n```";

describe("termsList", () => {
  it("returns the answer unchanged and no terms when there is no block", () => {
    expect(termsList("Leave the bass.")).toEqual({ answer: "Leave the bass.", terms: [] });
  });

  it("strips the block and returns one term per line", () => {
    const out = termsList(`Watch the gain reduction.\n\n${block("Gain reduction: How far the Compressor turns the signal down.")}`);
    expect(out).toEqual({
      answer: "Watch the gain reduction.",
      terms: [{ term: "Gain reduction", meaning: "How far the Compressor turns the signal down." }],
    });
  });

  it("keeps only the last block and strips every block", () => {
    const out = termsList(`A\n${block("First: one.")}\nB\n${block("Second: two.")}`);
    expect(out.terms).toEqual([{ term: "Second", meaning: "two." }]);
    expect(out.answer).not.toContain("```");
  });

  it("leaves an unclosed block as answer text", () => {
    const text = "Cut it.\n```terms\nRatio: how hard";
    expect(termsList(text)).toEqual({ answer: text, terms: [] });
  });

  it("drops a malformed line and keeps the rest", () => {
    const out = termsList(block("no colon here", ": no term", "Knee: ", "Knee: How gently it starts."));
    expect(out.terms).toEqual([{ term: "Knee", meaning: "How gently it starts." }]);
  });

  it("keeps the first four terms", () => {
    const lines = ["A: a.", "B: b.", "C: c.", "D: d.", "E: e."];
    expect(termsList(block(...lines)).terms.map((t) => t.term)).toEqual(["A", "B", "C", "D"]);
    expect(MAX_TERMS).toBe(4);
  });

  it("keeps one of two lines naming the same term", () => {
    const out = termsList(block("Knee: first.", "knee: second."));
    expect(out.terms).toEqual([{ term: "Knee", meaning: "first." }]);
  });

  it("cuts a long line at the cap", () => {
    const out = termsList(block("Knee: " + "x".repeat(TERM_LINE_MAX_CHARS)));
    expect(Array.from(`${out.terms[0].term}: ${out.terms[0].meaning}`)).toHaveLength(TERM_LINE_MAX_CHARS);
  });

  it("strips a terms block that sits beside a move block", () => {
    const raw = `Cut it.\n${"```move\n«Pad», mud: cut 300 Hz\n```"}\n${block("Low cut: Removes everything under a frequency.")}`;
    const out = termsList(raw);
    expect(out.answer).toBe("Cut it.\n```move\n«Pad», mud: cut 300 Hz\n```");
    expect(out.terms).toHaveLength(1);
  });
});
