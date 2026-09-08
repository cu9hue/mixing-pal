/**
 * A set's note: a short list of outcome bullets the model reads before it
 * answers and may extend by a delta or two per answer, and that she can
 * edit. Never a paragraph, never rewritten: the second brain's Context
 * Collapse note is why. Every change is a small edit this module applies
 * deterministically, growth is bounded by de-duplication and a cap, and a
 * bullet she has touched is hers: the model cannot retire it and the cap
 * cannot drop it.
 */

export type BulletKind = "move" | "heard" | "decided";

export const BULLET_KINDS: BulletKind[] = ["move", "heard", "decided"];

export interface Bullet {
  id: string;
  kind: BulletKind;
  text: string;
  /** Seconds since the epoch: added, or last edited by her. */
  at: number;
  hers: boolean;
}

export interface Note {
  bullets: Bullet[];
  /** The next id's number; ids never repeat within a set. */
  next: number;
}

export interface NoteDelta {
  adds: { kind: BulletKind; text: string }[];
  retires: string[];
}

/** Past this the note is a second prompt. */
export const NOTE_MAX_BULLETS = 12;
/** One line in the card and one line in the context block. */
export const BULLET_MAX_CHARS = 160;

export function emptyNote(): Note {
  return { bullets: [], next: 0 };
}

/** Lowercased, punctuation removed, whitespace collapsed: the identity two
 *  bullets are compared under. */
export function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BLOCK = /```note[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?[ \t]*```/g;
const ID = /^b\d+$/;

/** The prompt's "at most two changes" per answer: adds and retires share one
 *  budget, spent in order of appearance. */
const MAX_CHANGES_PER_ANSWER = 2;

/**
 * Splits a model answer into the text she reads and the note changes it
 * carried. Never throws. An unclosed block is text. Every block is
 * stripped; only the last one's lines count, since the model is told to
 * write one.
 */
export function noteDelta(answer: string): { answer: string; delta: NoteDelta } {
  const delta: NoteDelta = { adds: [], retires: [] };
  let last: string | null = null;
  for (const m of answer.matchAll(BLOCK)) last = m[1] ?? "";
  if (last === null) return { answer, delta };
  for (const raw of last.split(/\r?\n/)) {
    if (delta.adds.length + delta.retires.length >= MAX_CHANGES_PER_ANSWER) break;
    const line = raw.trim();
    if (line.startsWith("+ ")) {
      const [kind, ...rest] = line.slice(2).trim().split(/\s+/);
      const text = rest.join(" ").trim();
      if (isKind(kind) && text !== "") delta.adds.push({ kind, text });
    } else if (line.startsWith("- ")) {
      const id = line.slice(2).trim();
      if (ID.test(id)) delta.retires.push(id);
    }
  }
  const stripped = answer.replace(BLOCK, "").replace(/\n{3,}/g, "\n\n").trim();
  return { answer: stripped, delta };
}

function isKind(s: string): s is BulletKind {
  return (BULLET_KINDS as string[]).includes(s);
}

/**
 * One bullet in, unless its normalised text is already there. Hers or the
 * model's, by `hers`. Recording something the model already wrote is a
 * touch: a duplicate her add promotes that bullet to hers, keeping its id,
 * kind, text, and `at`.
 */
function addBulletUncapped(note: Note, kind: BulletKind, text: string, hers: boolean, now: number): Note {
  const clean = Array.from(text.trim()).slice(0, BULLET_MAX_CHARS).join("");
  if (clean === "") return note;
  const key = normalise(clean);
  if (key === "") return note;
  const dup = note.bullets.find((b) => normalise(b.text) === key);
  if (dup !== undefined) {
    if (hers && !dup.hers) {
      return { ...note, bullets: note.bullets.map((b) => (b.id === dup.id ? { ...b, hers: true } : b)) };
    }
    return note;
  }
  return {
    bullets: [...note.bullets, { id: `b${note.next}`, kind, text: clean, at: now, hers }],
    next: note.next + 1,
  };
}

/** `addBulletUncapped`, then the cap. For direct callers: the Notes row and
 *  the carry into a note restored across a set switch. `mergeNote` applies
 *  the cap itself, once, after its own adds and retires, so it uses the
 *  uncapped helper directly. */
export function addBullet(note: Note, kind: BulletKind, text: string, hers: boolean, now: number): Note {
  return capped(addBulletUncapped(note, kind, text, hers, now));
}

/** The model's changes, applied in order: adds, then retires, then one cap. */
export function mergeNote(note: Note, delta: NoteDelta, now: number): Note {
  let n = note;
  for (const a of delta.adds) n = addBulletUncapped(n, a.kind, a.text, false, now);
  const retire = new Set(delta.retires);
  n = { ...n, bullets: n.bullets.filter((b) => b.hers || !retire.has(b.id)) };
  return capped(n);
}

/** Drops the oldest model bullets until the note fits. Hers never go. */
function capped(note: Note): Note {
  const bullets = [...note.bullets];
  while (bullets.length > NOTE_MAX_BULLETS) {
    let oldest = -1;
    for (let i = 0; i < bullets.length; i++) {
      if (bullets[i].hers) continue;
      if (oldest === -1 || bullets[i].at < bullets[oldest].at) oldest = i;
    }
    if (oldest === -1) break;
    bullets.splice(oldest, 1);
  }
  return { ...note, bullets };
}

/** Her edit: the text changes, the bullet becomes hers, and its time moves. */
export function editBullet(note: Note, id: string, text: string, now: number): Note {
  const clean = Array.from(text.trim()).slice(0, BULLET_MAX_CHARS).join("");
  if (clean === "") return deleteBullet(note, id);
  return {
    ...note,
    bullets: note.bullets.map((b) => (b.id === id ? { ...b, text: clean, at: now, hers: true } : b)),
  };
}

/** Her delete removes any bullet, hers or the model's. */
export function deleteBullet(note: Note, id: string): Note {
  return { ...note, bullets: note.bullets.filter((b) => b.id !== id) };
}

/** "today", "yesterday", "3 days ago". Seconds since the epoch both ways. */
export function ageWords(at: number, now: number): string {
  const days = Math.max(0, Math.floor((now - at) / (24 * 60 * 60)));
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}
