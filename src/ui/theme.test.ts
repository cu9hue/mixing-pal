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

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** The hex value theme.css gives a token, or a failure naming it. */
function token(name: string): string {
  const theme = readFileSync(join(SRC, "ui/theme.css"), "utf8");
  const m = theme.match(new RegExp(`${name}:\\s*(#[0-9a-f]{6})`));
  if (m === null) throw new Error(`${name} is not a plain hex token in theme.css`);
  return m[1];
}

/**
 * The text steps are used for sentences on both surfaces, so the faintest
 * of them has to clear 4.5:1 on the raised one, the harder of the two. The
 * glyph step is for marks, where 3:1 is the bar. A retune that drops
 * either below its bar goes red here instead of in a producer's eyes.
 */
describe("text contrast", () => {
  it("keeps every text step readable as body copy on both surfaces", () => {
    for (const step of ["--text", "--text-secondary", "--text-muted", "--text-faint"]) {
      for (const surface of ["--surface", "--surface-raised", "--surface-sunken"]) {
        expect(contrast(token(step), token(surface)), `${step} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps the glyph step visible as a control mark", () => {
    for (const surface of ["--surface", "--surface-raised"]) {
      expect(contrast(token("--glyph-faint"), token(surface)), surface).toBeGreaterThanOrEqual(3);
    }
  });
});

/**
 * Type and spacing come from theme.css, so her system text size reaches
 * the card and the rhythm is one scale. A literal px size or gap in a
 * stylesheet is a hole in that: it neither resizes nor follows a retune.
 * Borders (1px) and zero are not spacing.
 */
describe("type and spacing tokens", () => {
  const sheets = cssFiles(join(SRC, "ui")).filter((f) => !f.endsWith("theme.css"));

  it("has no font size written in px", () => {
    for (const file of sheets) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/font(-size)?:\s*[0-9.]+px/);
    }
  });

  it("has no padding, margin, or gap written in px", () => {
    const spacing = /^\s*(padding|margin|gap|row-gap|column-gap|padding-[a-z]+|margin-[a-z]+):\s*([^;]+);/gm;
    for (const file of sheets) {
      for (const m of readFileSync(file, "utf8").matchAll(spacing)) {
        const literal = m[2].match(/(?<![0-9.])(?!1px)[0-9.]+px/);
        expect(literal, `${file}: ${m[0].trim()}`).toBeNull();
      }
    }
  });
});
