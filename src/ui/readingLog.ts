import { SetState } from "../live/model";
import { readLabel, trackName } from "./progressLabel";

/** One tool call this turn. `done` flips when the tool returns. */
export interface Read {
  name: string;
  args: unknown;
  done: boolean;
}

/** `check` is true for a finished read; a running read and the fold line have none. */
export interface LogLine {
  text: string;
  check: boolean;
}

/** The fold line counts toward this. */
const MAX_LINES = 4;
const MAX_NAMES = 3;

function nameList(names: string[]): string {
  if (names.length > MAX_NAMES) return `${names.slice(0, MAX_NAMES).join(", ")} and ${names.length - MAX_NAMES} more`;
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the model has looked at this turn, one line per kind of read.
 *
 * Reads with one tool merge into one line that lists their tracks, so eight
 * timeline reads are one line, and a track read twice is named once. A line
 * is in the present tense until every read in it has finished. If any read
 * in a group names no track the line drops the names: a list that left one
 * out would claim less than the model read. Like progressLabel, it names her
 * music and never a tool.
 */
export function readingLog(reads: Read[], state: SetState): LogLine[] {
  const groups = new Map<string, { tracks: string[]; plain: boolean; done: boolean; reads: number }>();
  for (const { name, args, done } of reads) {
    const group = groups.get(name) ?? { tracks: [], plain: false, done: true, reads: 0 };
    groups.set(name, group);
    const track = trackName(args, state);
    if (track === null) group.plain = true;
    else if (!group.tracks.includes(track)) group.tracks.push(track);
    group.done &&= done;
    group.reads += 1;
  }
  const lines = [...groups].map(([name, g]) => ({
    text: readLabel(name, g.plain ? null : nameList(g.tracks), g.done),
    check: g.done,
  }));
  if (lines.length <= MAX_LINES) return lines;
  const folded = lines.length - (MAX_LINES - 1);
  // The fold counts reads, not lines: one line can stand for several.
  const earlier = [...groups.values()].slice(0, folded).reduce((n, g) => n + g.reads, 0);
  return [{ text: `+${earlier} earlier reads`, check: false }, ...lines.slice(folded)];
}
