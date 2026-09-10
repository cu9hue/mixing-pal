import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const app = readFileSync(SRC + "App.tsx", "utf8");
const css = readFileSync(SRC + "ui/Card.css", "utf8");
const card = readFileSync(SRC + "ui/Card.tsx", "utf8");

/**
 * The conversation lives in `Conversation`'s own state, and `App` swaps
 * between the card and the pill. If the card were rendered conditionally,
 * every collapse would unmount that subtree and take the whole conversation
 * with it: the history the model is sent on the next turn, and any answer
 * still in flight, which would resolve into a dead closure and be lost.
 *
 * So `Card` is mounted unconditionally and hidden with CSS instead. That
 * invariant is currently held up by one class name in two files and nothing
 * else — this repo has no component-test setup, so these are source-level
 * tripwires in the same spirit as `theme.test.ts` and the connector
 * manifest test.
 *
 * What they can prove: the hiding mechanism exists and is wired. What they
 * cannot: that the conversation actually survives at runtime. Only a DOM
 * test could show that, and adding one means adding React Testing Library
 * and jsdom — a decision that belongs to a human, not to a test file.
 */
describe("the card stays mounted across a collapse", () => {
  it("hides the card with CSS rather than unmounting it", () => {
    expect(css).toMatch(/\.card-slot--hidden\s*\{[^}]*display:\s*none/);
  });

  it("applies that class from App rather than dropping the subtree", () => {
    expect(app).toContain("card-slot--hidden");
  });

  // The specific regression this guards. Reverting to conditional rendering
  // removes any reason to keep applying a hiding class, so the assertion
  // above goes red — but only if nobody leaves the class behind as a
  // decoration. This catches the case where they do.
  it("never renders Card behind a view check", () => {
    const guarded = /(\?|&&)\s*\(?\s*<Card\b/;
    expect(app).not.toMatch(guarded);
  });
});

/**
 * Settings replaces the card's content the same way: the conversation is
 * hidden with a class, never rendered behind the settings check.
 */
describe("the conversation stays mounted while Settings is open", () => {
  it("hides the card's main column with CSS", () => {
    expect(css).toMatch(/\.card__main--hidden\s*\{[^}]*display:\s*none/);
    expect(card).toContain("card__main--hidden");
  });

  it("never renders Conversation behind the settings check", () => {
    expect(card).not.toMatch(/settingsOpen[^<]*<Conversation\b/);
  });
});
