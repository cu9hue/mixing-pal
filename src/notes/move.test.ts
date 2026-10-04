import { describe, expect, it } from "vitest";
import { moveLabel } from "./move";
import { BULLET_MAX_CHARS, noteDelta } from "./note";

const block = (line: string) => "```move\n" + line + "\n```";

describe("moveLabel", () => {
  it("returns the answer unchanged and no move when there is no block", () => {
    expect(moveLabel("Leave the bass.")).toEqual({ answer: "Leave the bass.", move: null });
  });

  it("strips the block and returns its line", () => {
    const out = moveLabel(`Cut the pad.\n\n${block("«Pad», muddy low mids: cut 2 dB at 300 Hz")}`);
    expect(out).toEqual({ answer: "Cut the pad.", move: "«Pad», muddy low mids: cut 2 dB at 300 Hz" });
  });

  it("keeps only the last block and strips every block", () => {
    const out = moveLabel(`A\n${block("first")}\nB\n${block("second")}`);
    expect(out.move).toBe("second");
    expect(out.answer).not.toContain("```");
  });

  it("leaves an unclosed block as answer text", () => {
    const text = "Cut it.\n```move\n«Pad», cut";
    expect(moveLabel(text)).toEqual({ answer: text, move: null });
  });

  it("treats an empty block as no move", () => {
    expect(moveLabel("Fine.\n```move\n```")).toEqual({ answer: "Fine.", move: null });
  });

  it("cuts a long label at the bullet cap", () => {
    const long = "x".repeat(BULLET_MAX_CHARS + 30);
    expect(moveLabel(block(long)).move).toHaveLength(BULLET_MAX_CHARS);
  });

  it("strips a move block that comes before a note block", () => {
    const raw = `Cut it.\n${block("«Pad», mud: cut 300 Hz")}\n${"```note\n+ heard the pad was muddy\n```"}`;
    const { answer: afterNote, delta } = noteDelta(raw);
    const { answer, move } = moveLabel(afterNote);
    expect(delta.adds).toHaveLength(1);
    expect(move).toBe("«Pad», mud: cut 300 Hz");
    expect(answer).toBe("Cut it.");
  });
});
