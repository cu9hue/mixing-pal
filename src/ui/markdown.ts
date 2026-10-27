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
  | { type: "fence"; name: string }
  // A word she can tap for one plain line; `index` is its place in the
  // answer's terms. Added by `markTerms`, never by the parser. `fence` marks
  // a «name» that is the whole term, still shown as her name.
  | { type: "term"; text: string; index: number; fence?: true };

export type BlockNode =
  | { type: "paragraph"; children: InlineNode[] }
  | { type: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { type: "list"; ordered: boolean; items: InlineNode[][] }
  | { type: "code_block"; text: string }
  // Every row has exactly header.length cells; see collectTable.
  | { type: "table"; header: InlineNode[][]; rows: InlineNode[][][] };

const HEADING_RE = /^(#{1,3}) (.*)$/;
const UNORDERED_RE = /^[-*] /;
const ORDERED_RE = /^(\d+)\. (.*)$/;
// One cell of the delimiter row under a table's header: dashes with optional
// alignment colons. That row is what makes the lines around it a table.
const TABLE_DELIMITER_CELL_RE = /^:?-+:?$/;
// The prompt asks for at most three columns. Eight is the hard stop: past it
// padding every short row to the header's width has no bound but the model's
// output, and such a table is unreadable at the card's width anyway.
const MAX_TABLE_COLUMNS = 8;

/**
 * Splits one table row into its trimmed cells. Outer pipes are optional. A
 * pipe inside a code span or a «fenced» name stays in its cell -- a producer
 * can name a track "Bass|Sub" -- and `\|` is a literal pipe.
 */
function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let closer: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (closer !== null) {
      if (ch === closer) closer = null;
      cell += ch;
    } else if (ch === "\\" && s[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      if (ch === "`") closer = "`";
      else if (ch === "«") closer = "»";
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/** A header row over a delimiter row of the same width, within the cap. */
function startsTable(lines: string[], i: number): boolean {
  if (!isTableRow(lines[i]) || i + 1 >= lines.length || !isTableRow(lines[i + 1])) return false;
  const delimiter = tableCells(lines[i + 1]);
  return (
    delimiter.every((c) => TABLE_DELIMITER_CELL_RE.test(c)) &&
    delimiter.length === tableCells(lines[i]).length &&
    delimiter.length <= MAX_TABLE_COLUMNS
  );
}

/**
 * Gathers one pipe table starting at `start`, which `startsTable` has
 * accepted. Ends at the first line that is not a row. Rows are squared to
 * the header's width: a short row gets empty cells and a long row loses its
 * extras, so the renderer never meets a ragged table.
 */
function collectTable(
  lines: string[],
  start: number,
): { header: InlineNode[][]; rows: InlineNode[][][]; next: number } {
  const header = tableCells(lines[start]).map(parseInline);
  const rows: InlineNode[][][] = [];
  let i = start + 2;
  while (i < lines.length && isTableRow(lines[i])) {
    const cells = tableCells(lines[i]).slice(0, header.length);
    while (cells.length < header.length) cells.push("");
    rows.push(cells.map(parseInline));
    i++;
  }
  return { header, rows, next: i };
}

/**
 * Gathers one list's items, starting at `start`.
 *
 * A list ends at the first line that is neither another item of the same kind
 * nor a single blank line separating two such items. That blank-line
 * tolerance is the whole point: the model routinely writes "loose" lists with
 * a blank line between entries, and gathering only CONSECUTIVE item lines
 * turned each entry into its own single-item list. Because every <ol> restarts
 * its numbering, the producer then saw "1." against every row instead of
 * 1, 2, 3.
 *
 * Two blank lines still end the list -- that is a deliberate break, not a
 * separator -- and so does a change of marker, since `matches` is fixed to the
 * kind the list started with.
 */
function collectListItems(
  lines: string[],
  start: number,
  matches: (line: string) => boolean,
  content: (line: string) => string,
): { items: InlineNode[][]; next: number } {
  const items: InlineNode[][] = [];
  let i = start;
  while (i < lines.length) {
    if (matches(lines[i])) {
      items.push(parseInline(content(lines[i])));
      i++;
      continue;
    }
    // Only step over a blank line when another item of the same kind follows
    // it immediately; otherwise the blank belongs to whatever comes next.
    if (lines[i].trim() === "" && i + 1 < lines.length && matches(lines[i + 1])) {
      i++;
      continue;
    }
    break;
  }
  return { items, next: i };
}


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
        const list = collectListItems(lines, i, (l) => UNORDERED_RE.test(l), (l) => l.slice(2));
        blocks.push({ type: "list", ordered: false, items: list.items });
        i = list.next;
        continue;
      }

      if (ORDERED_RE.test(line)) {
        const list = collectListItems(
          lines,
          i,
          (l) => ORDERED_RE.test(l),
          (l) => ORDERED_RE.exec(l)![2],
        );
        blocks.push({ type: "list", ordered: true, items: list.items });
        i = list.next;
        continue;
      }

      if (startsTable(lines, i)) {
        const table = collectTable(lines, i);
        blocks.push({ type: "table", header: table.header, rows: table.rows });
        i = table.next;
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
      !ORDERED_RE.test(lines[i]) &&
      !startsTable(lines, i)
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

/** The indexes of the terms `markTerms` marked anywhere in one block. */
export function termsIn(block: BlockNode): number[] {
  const walk = (nodes: InlineNode[]): number[] => nodes.flatMap((n) =>
    n.type === "term" ? [n.index] : n.type === "bold" || n.type === "italic" ? walk(n.children) : []);
  switch (block.type) {
    case "paragraph":
    case "heading":
      return walk(block.children);
    case "list":
      return block.items.flatMap(walk);
    case "table":
      return [...block.header, ...block.rows.flat()].flatMap(walk);
    case "code_block":
      return [];
  }
}

// Letters and digits in any script. A term matches only where neither
// neighbour is one, so "knee" is not marked inside "kneecap".
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * A term as a pattern that also takes the forms the model writes it in: a
 * space and a hyphen stand for each other, and the last word may add "s" or
 * "es", so "Return track" finds "return tracks".
 */
function termPattern(term: string): string {
  const words = term.trim().split(/[\s-]+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `${words.join("[\\s-]+")}(?:es|s)?`;
}

/**
 * Marks the first occurrence of each term in the answer, matched
 * case-insensitively on word boundaries in any of `termPattern`'s forms,
 * longest term first so a short term cannot take the words of a longer one.
 * The mark keeps the prose's own text. Walks text inside bold and italic,
 * because the move is bold and often holds a term. Never code, and never
 * part of a «name». A «name» that is the whole term, or its plural, is
 * marked: the tools fence every device and parameter label. A term with no
 * match stays unmarked; the card lists it after the answer.
 */
export function markTerms(blocks: BlockNode[], terms: readonly { term: string }[]): BlockNode[] {
  const order = terms.map((t, index) => ({ term: t.term, index })).sort((a, b) => b.term.length - a.term.length);
  let out = blocks;
  for (const { term, index } of order) {
    if (term.trim() === "") continue;
    let done = false;
    const source = termPattern(term);
    const pattern = new RegExp(`${source}(?![\\p{L}\\p{N}])`, "giu");
    const whole = new RegExp(`^${source}$`, "iu");
    const inline = (nodes: InlineNode[]): InlineNode[] =>
      nodes.flatMap((n): InlineNode[] => {
        if (done) return [n];
        if (n.type === "bold" || n.type === "italic") return [{ ...n, children: inline(n.children) }];
        if (n.type === "fence" && whole.test(n.name)) {
          done = true;
          return [{ type: "term", text: n.name, index, fence: true }];
        }
        if (n.type !== "text") return [n];
        for (const m of n.text.matchAll(pattern)) {
          const start = m.index ?? 0;
          const end = start + m[0].length;
          if (WORD_CHAR.test(n.text[start - 1] ?? "")) continue;
          done = true;
          const before = n.text.slice(0, start);
          const after = n.text.slice(end);
          return [
            ...(before === "" ? [] : [{ type: "text" as const, text: before }]),
            { type: "term" as const, text: m[0], index },
            ...(after === "" ? [] : [{ type: "text" as const, text: after }]),
          ];
        }
        return [n];
      });
    out = out.map((b): BlockNode => {
      switch (b.type) {
        case "paragraph":
        case "heading":
          return { ...b, children: inline(b.children) };
        case "list":
          return { ...b, items: b.items.map(inline) };
        case "table":
          return { ...b, header: b.header.map(inline), rows: b.rows.map((r) => r.map(inline)) };
        case "code_block":
          return b;
      }
    });
  }
  return out;
}
