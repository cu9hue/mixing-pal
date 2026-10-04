import { BULLET_MAX_CHARS } from "./note";

/**
 * The move an answer gives, so a rating can say what was kept or undone.
 * Same rules as `noteDelta`: an unclosed block is text, the last block counts.
 */
const BLOCK = /```move[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?[ \t]*```/g;

export function moveLabel(answer: string): { answer: string; move: string | null } {
  let last: string | null = null;
  for (const m of answer.matchAll(BLOCK)) last = m[1] ?? "";
  if (last === null) return { answer, move: null };
  const line = last.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  const move = line === "" ? null : Array.from(line).slice(0, BULLET_MAX_CHARS).join("");
  const stripped = answer.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer: stripped, move };
}
