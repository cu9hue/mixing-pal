export interface Note {
  pitch: number;
  start: number;
  duration: number;
  velocity: number;
  mute: boolean;
}

const keyOf = (n: Note) => `${n.pitch}:${n.start}:${n.duration}:${n.velocity}`;

export function diffNotes(
  prev: Note[],
  next: Note[],
): { added: number; removed: number } {
  const before = new Set(prev.map(keyOf));
  const after = new Set(next.map(keyOf));
  let added = 0;
  let removed = 0;
  after.forEach((k) => {
    if (!before.has(k)) added += 1;
  });
  before.forEach((k) => {
    if (!after.has(k)) removed += 1;
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
