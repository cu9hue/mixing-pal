import { describe, expect, it } from "vitest";
import { EXAMPLE_QUESTIONS } from "./examples";

// Three is the number that fits under the goal without pushing the input
// off the first screen; a question longer than a line wraps into a
// paragraph and stops reading as a prompt she can click.
describe("the empty card's example questions", () => {
  it("are three short questions", () => {
    expect(EXAMPLE_QUESTIONS).toHaveLength(3);
    for (const q of EXAMPLE_QUESTIONS) {
      expect(q.endsWith("?")).toBe(true);
      expect(q.length).toBeLessThanOrEqual(48);
    }
  });
});
