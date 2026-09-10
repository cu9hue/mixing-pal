import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";

const UI = fileURLToPath(new URL(".", import.meta.url));
const read = (name: string) => readFileSync(UI + name, "utf8");

/**
 * Tauri's drag script (tauri 2.11, src/window/scripts/drag.js) walks up from
 * the mousedown target. A bare `data-tauri-drag-region` drags only when the
 * target is that element itself; `"deep"` drags from anywhere in the subtree;
 * `"false"` blocks the drag for the element and its ancestors; and a button,
 * input, or summary without its own attribute blocks it on its own.
 *
 * The first shell put a bare attribute on the header alone, and the goal
 * button filled that header, so the window moved only from the gaps between
 * elements. She had to hunt for the spot. The card root is now `"deep"`, and
 * the pins below are the exceptions that make that safe.
 *
 * Source-level tripwires, like cardStaysMounted.test.ts: this repo has no
 * DOM test setup. Each check looks for the attribute as a standalone JSX
 * attribute (whitespace before it, `=` after) inside the same tag as the
 * class name, in either order, so a value hidden in another attribute's
 * string does not count.
 */
function dragValue(source: string, className: string): string | null {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = new RegExp(`<\\w+(?:\\s[^<>]*?)?\\sclassName="${escaped}"(?:\\s[^<>]*?)?>`, "g");
  const attr = /\sdata-tauri-drag-region(?:="(deep|false|true)")?(?=[\s/>])/;
  let found: string | null = null;
  for (const m of source.matchAll(tag)) {
    const hit = attr.exec(m[0]);
    if (hit !== null) found = hit[1] ?? "";
  }
  return found;
}

describe("the card drags from everywhere she is likely to grab it", () => {
  const conversation = read("Conversation.tsx");

  it("drags from anywhere inside the card root", () => {
    expect(dragValue(read("Card.tsx"), "card")).toBe("deep");
  });

  // The body scrolls. Its own box, which is where the scrollbar thumb lives,
  // must not drag; the exchanges and the progress line inside it must.
  it("keeps the scrollbar's box out and puts the exchanges back in", () => {
    expect(dragValue(conversation, "card__body")).toBe("false");
    expect(dragValue(conversation, "card__exchange")).toBe("deep");
    // The progress line's className is a template literal, so match it directly.
    expect(conversation).toMatch(/card__progress\$\{[^}]*\}`\}\s+data-tauri-drag-region="deep"/);
  });

  // The answer and the error are the text worth copying; a drag there must
  // select, not move the window.
  it("but not from the answer or the error box", () => {
    expect(dragValue(conversation, "card__answer selectable")).toBe("false");
    expect(dragValue(conversation, "card__error selectable")).toBe("false");
  });

  // Nothing else needs its own attribute: a stray bare one would silently
  // narrow the deep region back to a single element.
  it("uses no bare attribute anywhere in the card", () => {
    for (const file of ["Card.tsx", "Header.tsx", "SetRow.tsx", "Noticed.tsx", "Conversation.tsx"]) {
      expect(read(file)).not.toMatch(/\sdata-tauri-drag-region(?=[\s/>])/);
    }
  });
});
