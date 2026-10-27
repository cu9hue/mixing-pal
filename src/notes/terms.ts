import { lineMaxChars, maxTerms } from "../../shared/term-vectors.json";

/** One term an answer explains on a tap. */
export interface Term {
  term: string;
  meaning: string;
}

/**
 * Both limits live in shared/term-vectors.json, which the prompt test and the eval read.
 * More marks than this would cover half the answer; a runaway line is cut.
 */
export const MAX_TERMS: number = maxTerms;
export const TERM_LINE_MAX_CHARS: number = lineMaxChars;

const BLOCK = /```terms[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?[ \t]*```/g;
const LIST_MARKER = /^(?:[-*]|\d+\.)\s+/;

/** The term without a list marker or the markup the model wraps labels in. */
function cleanTerm(raw: string): string {
  return raw.trim().replace(LIST_MARKER, "").replace(/^[*`«\s]+/, "").replace(/[*`»\s]+$/, "");
}

/**
 * The terms an answer lists for her to tap. Same rules as `moveLabel`: an unclosed block is
 * text, the last block counts. A line without a term and a meaning around its colon is dropped.
 */
export function termsList(answer: string): { answer: string; terms: Term[] } {
  let last: string | null = null;
  for (const m of answer.matchAll(BLOCK)) last = m[1] ?? "";
  if (last === null) return { answer, terms: [] };
  const terms: Term[] = [];
  for (const raw of last.split(/\r?\n/)) {
    const line = Array.from(raw.trim()).slice(0, TERM_LINE_MAX_CHARS).join("");
    const colon = line.indexOf(":");
    const term = cleanTerm(line.slice(0, colon));
    // "**Knee:** meaning" leaves the bold's close at the meaning's start.
    const meaning = line.slice(colon + 1).replace(/^[*\s]+/, "").trim();
    if (colon === -1 || term === "" || meaning === "") continue;
    if (terms.some((t) => t.term.toLowerCase() === term.toLowerCase())) continue;
    terms.push({ term, meaning });
    if (terms.length === MAX_TERMS) break;
  }
  const stripped = answer.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer: stripped, terms };
}
