import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { createHash } from "node:crypto";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";

/**
 * The striped colour block that stood in for the step-3 screenshot until
 * 2026-08-31. It shipped: a build went out to a first tester with a magenta
 * barber pole on the one screen whose whole job is letting someone compare
 * what is in front of them in Live to what is on screen.
 *
 * A manual checklist once had an item for exactly this and it did not help,
 * because a document marked PENDING-USER fails nothing. This does.
 *
 * Pinning the placeholder rather than the real file is deliberate. The
 * screenshot is meant to be re-captured whenever Live's layout changes, so
 * pinning the good bytes would turn a required update into a broken build.
 */
const PLACEHOLDER_SHA256 =
  "f0c14001a06acfa285054bce8feb0b370d0207829cfc540d154c1a040cb5e2a0";

describe("the Control Surface screenshot", () => {
  it("is a real screenshot, not the placeholder", () => {
    const png = readFileSync(
      fileURLToPath(new URL("../../public/control-surface.png", import.meta.url)),
    );
    const sha = createHash("sha256").update(png).digest("hex");
    expect(sha).not.toBe(PLACEHOLDER_SHA256);
  });
});
