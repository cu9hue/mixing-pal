/** One term an answer explains on a tap. */
export interface Term {
  term: string;
  meaning: string;
}

/** The prompt asks for at most four; more would mark half the answer. */
export const MAX_TERMS = 4;
/** One plain sentence fits well inside this. A runaway line is cut here. */
export const TERM_LINE_MAX_CHARS = 200;

/**
 * The terms an answer lists for her to tap. Same rules as `moveLabel`: an
 * unclosed block is text, the last block counts. A line without a term and a
 * meaning on either side of its first colon is dropped.
 */
const BLOCK = /```terms[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?[ \t]*```/g;

export function termsList(answer: string): { answer: string; terms: Term[] } {
  let last: string | null = null;
  for (const m of answer.matchAll(BLOCK)) last = m[1] ?? "";
  if (last === null) return { answer, terms: [] };
  const terms: Term[] = [];
  for (const raw of last.split(/\r?\n/)) {
    const line = Array.from(raw.trim()).slice(0, TERM_LINE_MAX_CHARS).join("");
    const colon = line.indexOf(":");
    const term = line.slice(0, colon).trim();
    const meaning = line.slice(colon + 1).trim();
    if (colon === -1 || term === "" || meaning === "") continue;
    if (terms.some((t) => t.term.toLowerCase() === term.toLowerCase())) continue;
    terms.push({ term, meaning });
    if (terms.length === MAX_TERMS) break;
  }
  const stripped = answer.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer: stripped, terms };
}
