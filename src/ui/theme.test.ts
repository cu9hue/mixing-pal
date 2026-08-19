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

describe("design tokens", () => {
  // The whole point of moving off inline style objects was to get one
  // place where colour lives. A var(--typo) silently renders as nothing,
  // which looks like a layout bug and gets debugged as one.
  it("defines every custom property that any stylesheet reads", () => {
    const known = defined();
    const orphans = used().filter((u) => !known.has(u.name));
    expect(orphans).toEqual([]);
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
