export interface Note {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

const keyOf = (n: Note) => `${n.pitch}:${n.start}:${n.duration}:${n.velocity}`;

function countByKey(notes: Note[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const n of notes) {
    const k = keyOf(n);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

export function diffNotes(
  prev: Note[],
  next: Note[],
): { added: number; removed: number } {
  // A plain Set collapses duplicates, so two identical stacked notes losing
  // one is indistinguishable from no change at all. Live permits duplicate
  // pitch/start/duration/velocity notes (distinguished only by note_id,
  // which this scheme doesn't track), so counts per key, not just presence.
  const before = countByKey(prev);
  const after = countByKey(next);
  let added = 0;
  let removed = 0;
  const keys = new Set([...before.keys(), ...after.keys()]);
  keys.forEach((k) => {
    const diff = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    if (diff > 0) added += diff;
    else if (diff < 0) removed += -diff;
  });
  return { added, removed };
}

export class NoteTracker {
  private clipId: string | null = null;
  private notes: Note[] = [];

  update(
    clipId: string | null,
    notes: Note[],
  ): { changed: boolean; added: number; removed: number } {
    // A different clip is a new baseline, never an edit. Diffing across a
    // selection change would report an edit the producer never made.
    if (clipId !== this.clipId) {
      this.clipId = clipId;
      this.notes = notes;
      return { changed: false, added: 0, removed: 0 };
    }
    const { added, removed } = diffNotes(this.notes, notes);
    this.notes = notes;
    return { changed: added > 0 || removed > 0, added, removed };
  }
}
