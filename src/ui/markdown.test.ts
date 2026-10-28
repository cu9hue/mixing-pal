import { describe, expect, it } from "vitest";
import { markTerms, parseMarkdown, type BlockNode, type InlineNode } from "./markdown";

function paragraph(md: string): InlineNode[] {
  const blocks = parseMarkdown(md);
  expect(blocks).toHaveLength(1);
  const block = blocks[0];
  expect(block.type).toBe("paragraph");
  return (block as Extract<BlockNode, { type: "paragraph" }>).children;
}

describe("parseMarkdown inline spans", () => {
  it("parses bold", () => {
    expect(paragraph("**loud**")).toEqual([
      { type: "bold", children: [{ type: "text", text: "loud" }] },
    ]);
  });

  it("parses italic with either marker", () => {
    expect(paragraph("*soft*")).toEqual([
      { type: "italic", children: [{ type: "text", text: "soft" }] },
    ]);
    expect(paragraph("_soft_")).toEqual([
      { type: "italic", children: [{ type: "text", text: "soft" }] },
    ]);
  });

  it("parses inline code", () => {
    expect(paragraph("`gain -6dB`")).toEqual([{ type: "code", text: "gain -6dB" }]);
  });

  it("mixes plain text with spans", () => {
    expect(paragraph("pull **Kick** down a touch")).toEqual([
      { type: "text", text: "pull " },
      { type: "bold", children: [{ type: "text", text: "Kick" }] },
      { type: "text", text: " down a touch" },
    ]);
  });
});

describe("parseMarkdown fence chips", () => {
  it("turns a fenced set-derived name into a fence node without the guillemets", () => {
    expect(paragraph("cut «Extra Hats» by 3dB")).toEqual([
      { type: "text", text: "cut " },
      { type: "fence", name: "Extra Hats" },
      { type: "text", text: " by 3dB" },
    ]);
  });
});

describe("parseMarkdown lists", () => {
  it("groups consecutive `- ` lines into one unordered list", () => {
    const blocks = parseMarkdown("- kick\n- snare");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "kick" }],
          [{ type: "text", text: "snare" }],
        ],
      },
    ]);
  });

  it("groups consecutive `* ` lines the same way", () => {
    const blocks = parseMarkdown("* kick\n* snare");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: false,
        items: [
          [{ type: "text", text: "kick" }],
          [{ type: "text", text: "snare" }],
        ],
      },
    ]);
  });

  it("groups consecutive numbered lines into one ordered list", () => {
    const blocks = parseMarkdown("1. tighten the low end\n2. widen the pad");
    expect(blocks).toEqual([
      {
        type: "list",
        ordered: true,
        items: [
          [{ type: "text", text: "tighten the low end" }],
          [{ type: "text", text: "widen the pad" }],
        ],
      },
    ]);
  });
});

describe("parseMarkdown headings", () => {
  it("parses #, ##, ### as heading blocks carrying their level, not a font size", () => {
    // The renderer is responsible for keeping these visually small (an
    // emphasised line, not large type) in a pane this size -- the AST just
    // needs to say which level it was.
    expect(parseMarkdown("# Mix notes")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "Mix notes" }] },
    ]);
    expect(parseMarkdown("## Mix notes")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "Mix notes" }] },
    ]);
    expect(parseMarkdown("### Mix notes")).toEqual([
      { type: "heading", level: 3, children: [{ type: "text", text: "Mix notes" }] },
    ]);
  });
});

describe("parseMarkdown fenced code blocks", () => {
  it("renders a closed ``` fence as one code_block, unparsed", () => {
    expect(parseMarkdown("```\nlet x = **not bold**\n```")).toEqual([
      { type: "code_block", text: "let x = **not bold**" },
    ]);
  });
});

describe("parseMarkdown tables", () => {
  const text = (t: string) => [{ type: "text", text: t }];

  it("parses a header row, a delimiter row, and body rows into one table", () => {
    const md = "| Axis | Gabber | Bouncy |\n|---|---|---|\n| Kick | every beat | syncopated |\n| Bass | 16ths | sustained |";
    expect(parseMarkdown(md)).toEqual([
      {
        type: "table",
        header: [text("Axis"), text("Gabber"), text("Bouncy")],
        rows: [
          [text("Kick"), text("every beat"), text("syncopated")],
          [text("Bass"), text("16ths"), text("sustained")],
        ],
      },
    ]);
  });

  it("parses inline spans inside a cell", () => {
    const md = "| a | b |\n| --- | :-: |\n| **Kick** | «808 Sub» |";
    expect(parseMarkdown(md)).toEqual([
      {
        type: "table",
        header: [text("a"), text("b")],
        rows: [[[{ type: "bold", children: text("Kick") }], [{ type: "fence", name: "808 Sub" }]]],
      },
    ]);
  });

  // The delimiter row is what makes it a table. Without it a line with pipes
  // is prose that happens to contain pipes.
  it("leaves a pipe line with no delimiter row as a paragraph", () => {
    expect(parseMarkdown("| not | a table |")).toEqual([
      { type: "paragraph", children: text("| not | a table |") },
    ]);
  });

  // A short row is padded and a long row is cut to the header's width, so
  // the renderer never sees a ragged table.
  it("squares a ragged row to the header's column count", () => {
    const md = "| a | b |\n|---|---|\n| only |\n| x | y | extra |";
    expect(parseMarkdown(md)).toEqual([
      {
        type: "table",
        header: [text("a"), text("b")],
        rows: [
          [text("only"), []],
          [text("x"), text("y")],
        ],
      },
    ]);
  });

  it("ends the table at the first line without pipes", () => {
    const blocks = parseMarkdown("| a |\n|---|\n| 1 |\nthen prose");
    expect(blocks.map((b) => b.type)).toEqual(["table", "paragraph"]);
  });

  // A producer can name a track "Bass|Sub". The fence around it, or a code
  // span, keeps that pipe inside one cell.
  it("keeps a pipe inside a fenced name or a code span in one cell", () => {
    const md = "| Track | Note |\n|---|---|\n| «Bass|Sub» | `a|b` |";
    expect(parseMarkdown(md)).toEqual([
      {
        type: "table",
        header: [text("Track"), text("Note")],
        rows: [[[{ type: "fence", name: "Bass|Sub" }], [{ type: "code", text: "a|b" }]]],
      },
    ]);
  });

  it("unescapes a backslash-pipe into a literal pipe", () => {
    expect(parseMarkdown("| a |\n|---|\n| x \\| y |")).toEqual([
      { type: "table", header: [text("a")], rows: [[text("x | y")]] },
    ]);
  });

  it("accepts a table without outer pipes", () => {
    expect(parseMarkdown("a | b\n--- | ---\n1 | 2")).toEqual([
      { type: "table", header: [text("a"), text("b")], rows: [[text("1"), text("2")]] },
    ]);
  });

  it("does not start a table when the delimiter row has a different column count", () => {
    const blocks = parseMarkdown("| A | B |\n|---|\n| 1 | 2 |");
    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
  });

  // The prompt's budget is three columns; eight is the parser's hard stop,
  // past which padding short rows to the header's width would have no bound
  // but the model's output. Such a table is unreadable at 380px anyway.
  it("leaves a table wider than eight columns as prose", () => {
    const cells = (n: number) => "| " + Array.from({ length: n }, (_, i) => `c${i}`).join(" | ") + " |";
    const delim = (n: number) => "|" + "---|".repeat(n);
    expect(parseMarkdown(`${cells(8)}\n${delim(8)}`)[0].type).toBe("table");
    expect(parseMarkdown(`${cells(9)}\n${delim(9)}`)[0].type).toBe("paragraph");
  });
});

describe("parseMarkdown paragraphs", () => {
  it("splits on blank lines", () => {
    const blocks = parseMarkdown("first idea\n\nsecond idea");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "first idea" }] },
      { type: "paragraph", children: [{ type: "text", text: "second idea" }] },
    ]);
  });

  it("keeps consecutive non-blank lines in one paragraph", () => {
    const blocks = parseMarkdown("line one\nline two");
    expect(blocks).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "line one\nline two" }] },
    ]);
  });
});

describe("parseMarkdown malformed input degrades to plain text, never throws", () => {
  it("treats an unclosed ** as literal asterisks", () => {
    expect(() => parseMarkdown("**never closes")).not.toThrow();
    expect(paragraph("**never closes")).toEqual([{ type: "text", text: "**never closes" }]);
  });

  it("treats a stray backtick as a literal character", () => {
    expect(() => parseMarkdown("`never closes")).not.toThrow();
    expect(paragraph("`never closes")).toEqual([{ type: "text", text: "`never closes" }]);
  });

  it("treats an unclosed italic marker as literal", () => {
    expect(() => parseMarkdown("*never closes")).not.toThrow();
    expect(paragraph("*never closes")).toEqual([{ type: "text", text: "*never closes" }]);
  });

  it("does not throw on a list marker with nothing after it", () => {
    expect(() => parseMarkdown("- ")).not.toThrow();
    expect(parseMarkdown("- ")).toEqual([{ type: "list", ordered: false, items: [[]] }]);
  });

  it("does not throw on a fence marker that never closes", () => {
    expect(() => parseMarkdown("«never closes")).not.toThrow();
    expect(paragraph("«never closes")).toEqual([{ type: "text", text: "«never closes" }]);
  });

  it("does not throw on an unclosed code fence", () => {
    expect(() => parseMarkdown("```\nno closing fence")).not.toThrow();
    expect(parseMarkdown("```\nno closing fence")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "```\nno closing fence" }] },
    ]);
  });

  it("returns no blocks for an empty string", () => {
    expect(() => parseMarkdown("")).not.toThrow();
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("parseMarkdown and raw HTML", () => {
  it("never turns a producer-controlled track name's HTML into structure -- only ever a text leaf", () => {
    // A downloaded template's track name reaches the model's reply as
    // ordinary text (the backend fences it, but the model may quote it back
    // unfenced in prose). This parser must not special-case angle brackets
    // at all: the entire string comes back as one text node, exactly as
    // written, never as an element the renderer could mistake for markup.
    const hostile = 'look at <img src=x onerror=alert(1)> and <script>alert(1)</script>';
    const blocks = parseMarkdown(hostile);
    expect(blocks).toEqual([{ type: "paragraph", children: [{ type: "text", text: hostile }] }]);

    // The same string inside a table cell is still one text leaf.
    const inCell = parseMarkdown(`| a |\n|---|\n| ${hostile} |`);
    expect(inCell).toEqual([
      { type: "table", header: [[{ type: "text", text: "a" }]], rows: [[[{ type: "text", text: hostile }]]] },
    ]);

    // No node anywhere in the tree is anything but text/bold/italic/code/fence/
    // paragraph/heading/list/code_block/table -- there is no "html" or "raw"
    // node type this parser could produce, so there is no path from this
    // string to markup.
    const allowedTypes = new Set([
      "text",
      "bold",
      "italic",
      "code",
      "fence",
      "paragraph",
      "heading",
      "list",
      "code_block",
      "table",
    ]);
    function walk(node: BlockNode | InlineNode) {
      expect(allowedTypes.has(node.type)).toBe(true);
      if (node.type === "paragraph" || node.type === "heading") walk_all(node.children);
      if (node.type === "bold" || node.type === "italic") walk_all(node.children);
      if (node.type === "list") node.items.forEach(walk_all);
      if (node.type === "table") {
        node.header.forEach(walk_all);
        node.rows.forEach((row) => row.forEach(walk_all));
      }
    }
    function walk_all(nodes: InlineNode[]) {
      nodes.forEach(walk);
    }
    blocks.forEach(walk);
    inCell.forEach(walk);
  });
});

describe("loose lists", () => {
  // The model routinely puts a blank line between list items. Before this,
  // the parser only gathered CONSECUTIVE item lines, so each item became its
  // own single-item list -- and since every <ol> restarts its numbering, the
  // producer saw "1." against every entry instead of 1, 2, 3.
  it("keeps a blank-separated ordered list as one list", () => {
    const blocks = parseMarkdown("1. one\n\n2. two\n\n3. three");
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<BlockNode, { type: "list" }>;
    expect(list.type).toBe("list");
    expect(list.ordered).toBe(true);
    expect(list.items).toHaveLength(3);
  });

  it("keeps a blank-separated unordered list as one list", () => {
    const blocks = parseMarkdown("- one\n\n- two");
    expect(blocks).toHaveLength(1);
    const list = blocks[0] as Extract<BlockNode, { type: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items).toHaveLength(2);
  });

  // A blank line still ends the list when what follows is not another item.
  it("ends the list when the next block is prose", () => {
    const blocks = parseMarkdown("1. one\n\n2. two\n\nRoll the pad off at 180 Hz.");
    expect(blocks.map((b) => b.type)).toEqual(["list", "paragraph"]);
    expect((blocks[0] as Extract<BlockNode, { type: "list" }>).items).toHaveLength(2);
  });

  // Switching marker type starts a new list rather than merging.
  it("does not merge an ordered list into an unordered one", () => {
    const blocks = parseMarkdown("- one\n\n1. two");
    expect(blocks.map((b) => b.type)).toEqual(["list", "list"]);
    expect((blocks[0] as Extract<BlockNode, { type: "list" }>).ordered).toBe(false);
    expect((blocks[1] as Extract<BlockNode, { type: "list" }>).ordered).toBe(true);
  });

  // Two blank lines is a deliberate break, not a continuation.
  it("ends the list on a two-line gap", () => {
    const blocks = parseMarkdown("1. one\n\n\n1. two");
    expect(blocks).toHaveLength(2);
  });
});

describe("markTerms", () => {
  const terms = (...names: string[]) => names.map((term) => ({ term, meaning: `${term} means this.` }));
  const marked = (md: string, ...names: string[]) => markTerms(parseMarkdown(md), terms(...names));

  it("marks the first occurrence, case-insensitively, and keeps the prose's spelling", () => {
    expect(marked("Gain reduction is low. More gain reduction later.", "gain reduction")).toEqual([
      { type: "paragraph", children: [
        { type: "term", text: "Gain reduction", index: 0 },
        { type: "text", text: " is low. More gain reduction later." },
      ] },
    ]);
  });

  it("keeps the prose's own word form on the mark", () => {
    expect(marked("No sends, and no gain-reduction.", "Send", "Gain reduction")[0]).toEqual({ type: "paragraph", children: [
      { type: "text", text: "No " },
      { type: "term", text: "sends", index: 0 },
      { type: "text", text: ", and no " },
      { type: "term", text: "gain-reduction", index: 1 },
      { type: "text", text: "." },
    ] });
  });

  it("matches on word boundaries only", () => {
    expect(marked("The kneecap is fine.", "knee")).toEqual(parseMarkdown("The kneecap is fine."));
    expect(marked("A soft knee, then.", "knee")[0]).toEqual({ type: "paragraph", children: [
      { type: "text", text: "A soft " },
      { type: "term", text: "knee", index: 0 },
      { type: "text", text: ", then." },
    ] });
  });

  it("gives a longer term its words before a shorter one inside it", () => {
    expect(marked("Set the make-up gain, then the gain.", "gain", "make-up gain")[0]).toEqual({ type: "paragraph", children: [
      { type: "text", text: "Set the " },
      { type: "term", text: "make-up gain", index: 1 },
      { type: "text", text: ", then the " },
      { type: "term", text: "gain", index: 0 },
      { type: "text", text: "." },
    ] });
  });

  it("marks a term inside the bold move and inside italic", () => {
    expect(marked("**Lower the threshold.** *Watch the knee.*", "threshold", "knee")[0]).toEqual({ type: "paragraph", children: [
      { type: "bold", children: [
        { type: "text", text: "Lower the " },
        { type: "term", text: "threshold", index: 0 },
        { type: "text", text: "." },
      ] },
      { type: "text", text: " " },
      { type: "italic", children: [
        { type: "text", text: "Watch the " },
        { type: "term", text: "knee", index: 1 },
        { type: "text", text: "." },
      ] },
    ] });
  });

  it("never marks code or part of the producer's name", () => {
    const md = "«Glue Bus» and `Glue` stay theirs. Glue here.";
    expect(marked(md, "Glue")[0]).toEqual({ type: "paragraph", children: [
      { type: "fence", name: "Glue Bus" },
      { type: "text", text: " and " },
      { type: "code", text: "Glue" },
      { type: "text", text: " stay theirs. " },
      { type: "term", text: "Glue", index: 0 },
      { type: "text", text: " here." },
    ] });
  });

  // The tools fence every device and parameter name, so a label the model
  // explains usually arrives as a «name». The line it opens is the model's text.
  it("marks a fenced name that is the whole term, keeping it a fence", () => {
    expect(marked("Raise «threshold», then the threshold.", "Threshold")[0]).toEqual({ type: "paragraph", children: [
      { type: "text", text: "Raise " },
      { type: "term", text: "threshold", index: 0, fence: true },
      { type: "text", text: ", then the threshold." },
    ] });
  });

  it("marks terms in later blocks, lists, and tables, first occurrence across the answer", () => {
    const blocks = marked("No term here.\n\n- the ratio\n\n| a | b |\n|---|---|\n| ratio | knee |", "ratio", "knee");
    expect(blocks[1]).toEqual({ type: "list", ordered: false, items: [[
      { type: "text", text: "the " },
      { type: "term", text: "ratio", index: 0 },
    ]] });
    expect(blocks[2]).toMatchObject({ type: "table", rows: [[
      [{ type: "text", text: "ratio" }],
      [{ type: "term", text: "knee", index: 1 }],
    ]] });
  });

  it("leaves the blocks as they are when a term has no match", () => {
    expect(marked("Leave it.", "sidechain")).toEqual(parseMarkdown("Leave it."));
    expect(marked("Leave it.")).toEqual(parseMarkdown("Leave it."));
  });

  it("treats a term's punctuation literally", () => {
    expect(marked("Use a 4:1 ratio (1:4 is not one).", "4:1")[0]).toEqual({ type: "paragraph", children: [
      { type: "text", text: "Use a " },
      { type: "term", text: "4:1", index: 0 },
      { type: "text", text: " ratio (1:4 is not one)." },
    ] });
  });
});
