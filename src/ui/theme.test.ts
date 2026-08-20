import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { join } from "node:path";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry: string) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** Every `--name` given a value anywhere under src/. */
function defined(): Set<string> {
  const names = new Set<string>();
  for (const file of cssFiles(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Every `var(--name)` read anywhere under src/, with the file that reads it. */
function used(): Array<{ name: string; file: string }> {
  return cssFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => ({
      name: m[1],
      file,
    })),
  );
}

/**
 * Custom properties whose value comes from TypeScript rather than from a
 * stylesheet, mapped to the file that sets them.
 *
 * `--card-max-height` is the card's ceiling. It has to be one number:
 * Card.css clamps the element with it and App asks the window for the same
 * height, and when they disagreed -- CSS said 100vh -- the measurement
 * became a fixed point and the card could never grow back out of the pill.
 * MODE_GEOMETRY owns it; App publishes it here.
 */
const SET_FROM_TS: Record<string, string> = {
  "--card-max-height": "App.tsx",
};

describe("design tokens", () => {
  // The whole point of moving off inline style objects was to get one
  // place where colour lives. A var(--typo) silently renders as nothing,
  // which looks like a layout bug and gets debugged as one.
  it("defines every custom property that any stylesheet reads", () => {
    const known = defined();
    const orphans = used().filter((u) => !known.has(u.name) && !(u.name in SET_FROM_TS));
    expect(orphans).toEqual([]);
  });

  // Without this the exemption list above would become the hiding place
  // for exactly the typo the orphan check exists to catch.
  it("keeps the properties set from TypeScript honest", () => {
    for (const [token, file] of Object.entries(SET_FROM_TS)) {
      const source = readFileSync(join(SRC, file), "utf8");
      expect(source, `${file} must set ${token}`).toContain(`setProperty("${token}"`);
    }
    // One number, in one place: MODE_GEOMETRY.
    expect(readFileSync(join(SRC, "App.tsx"), "utf8")).toContain(
      "`${CARD_MAX_HEIGHT}px`",
    );
  });

  it("defines the palette the spec names", () => {
    const known = defined();
    for (const token of [
      "--surface",
      "--surface-raised",
      "--surface-sunken",
      "--border",
      "--border-strong",
      "--text",
      "--text-secondary",
      "--text-muted",
      "--text-faint",
      "--accent",
      "--ok",
      "--error",
      "--radius-card",
      "--radius-control",
      "--radius-pill",
      "--shadow-card",
    ]) {
      expect(known, `missing token ${token}`).toContain(token);
    }
  });
});
