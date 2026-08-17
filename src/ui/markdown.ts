// A hand-rolled parser for the small markdown subset the model's prose
// actually uses, plus the «fenced» spans src/digest/fence.ts wraps
// set-derived names in.
//
// PURE DATA ONLY. No JSX, no React import here -- Chat.tsx maps this AST to
// elements. That split is what makes the parser testable: this repo has no
// component-test framework, so a parser returning plain objects is exercised
// directly in Vitest, while a parser that built JSX would only be checkable
// by rendering a component. It also keeps the security property machine-
// checkable: every leaf here is a plain string, so the renderer can only
// ever hand React a text child, never markup -- there is no code path from
// model text to `dangerouslySetInnerHTML`.
//
// Anything that doesn't parse cleanly (an unclosed `**`, a stray backtick, a
// list marker with nothing after it) must fall back to plain text, never
// throw: a parser exception here would take the whole chat pane down.

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "bold"; children: InlineNode[] }
  | { type: "italic"; children: InlineNode[] }
  | { type: "code"; text: string }
  // The producer-controlled name a set-derived string was fenced with
  // (guillemets stripped). Rendered as a chip so the producer can tell it
  // apart from the model's own words.
  | { type: "fence"; name: string };

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "code_block"; text: string };

const HEADING_RE = /^(#{1,3}) (.*)$/;
const UNORDERED_RE = /^[-*] /;
const ORDERED_RE = /^(\d+)\. (.*)$/;

/**
 * Parses a chat message body into a block AST. Never throws: any input this
 * cannot make sense of degrades to a plain-text paragraph.
 */
export function parseMarkdown(markdown: string): BlockNode[] {
  try {
    return parseBlocks(markdown);
  } catch {
    return [{ type: "paragraph", children: [{ type: "text", text: markdown }] }];
  }
}

function parseBlocks(markdown: string): BlockNode[] {
  const lines = markdown.split("\n");
  const blocks: BlockNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (line.trim().startsWith("```")) {
      const closeIdx = lines.findIndex((l, idx) => idx > i && l.trim() === "```");
      if (closeIdx !== -1) {
        blocks.push({ type: "code_block", text: lines.slice(i + 1, closeIdx).join("\n") });
        i = closeIdx + 1;
        continue;
      }
      // Unclosed fence: there is no code block to close, so treat the rest
      // of the message as one literal paragraph rather than an open block
      // that never ends. Handled here, not by falling into the paragraph
      // loop below -- that loop deliberately stops at a ``` line, which
      // would otherwise leave i unchanged and loop forever. Skips inline
      // parsing too: the remaining backticks are exactly what's unclosed,
      // so running them back through parseInline would just reinterpret
      // them instead of showing them as-is.
      blocks.push({
        type: "paragraph",
        children: [{ type: "text", text: lines.slice(i).join("\n") }],
      });
      return blocks;
    } else {
      const heading = HEADING_RE.exec(line);
      if (heading) {
        const level = heading[1].length as 1 | 2 | 3;
        blocks.push({ type: "heading", level, children: parseInline(heading[2]) });
        i++;
        continue;
      }

      if (UNORDERED_RE.test(line)) {
        const items: InlineNode[][] = [];
        while (i < lines.length && UNORDERED_RE.test(lines[i])) {
          items.push(parseInline(lines[i].slice(2)));
          i++;
        }
        blocks.push({ type: "list", ordered: false, items });
        continue;
      }

      if (ORDERED_RE.test(line)) {
        const items: InlineNode[][] = [];
        while (i < lines.length && ORDERED_RE.test(lines[i])) {
          items.push(parseInline(ORDERED_RE.exec(lines[i])![2]));
          i++;
        }
        blocks.push({ type: "list", ordered: true, items });
        continue;
      }
    }

    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trim().startsWith("```") &&
      !HEADING_RE.test(lines[i]) &&
      !UNORDERED_RE.test(lines[i]) &&
      !ORDERED_RE.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "paragraph", children: parseInline(paraLines.join("\n")) });
  }

  return blocks;
}

/**
 * Parses one line's (or paragraph's) worth of text for inline markers.
 * Unmatched markers -- a `**` with no closing `**`, a lone backtick -- are
 * emitted as literal characters rather than treated as an error.
 */
function parseInline(text: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer !== "") {
      nodes.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "«") {
      const end = text.indexOf("»", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "fence", name: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === "`") {
      const end = text.indexOf("`", i + 1);
      if (end !== -1) {
        flush();
        nodes.push({ type: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (text.startsWith("**", i)) {
      const end = text.indexOf("**", i + 2);
      if (end !== -1 && end > i + 2) {
        flush();
        nodes.push({ type: "bold", children: parseInline(text.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    } else if (ch === "*" || ch === "_") {
      const end = text.indexOf(ch, i + 1);
      if (end !== -1 && end > i + 1) {
        flush();
        nodes.push({ type: "italic", children: parseInline(text.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    buffer += ch;
    i++;
  }

  flush();
  return nodes;
}
