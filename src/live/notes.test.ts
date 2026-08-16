import { describe, it, expect } from "vitest";
import { NoteTracker, diffNotes, Note } from "./notes";

const note = (pitch: number, start: number): Note => ({
  pitch,
  start,
  duration: 0.5,
  velocity: 100,
  mute: false,
});

describe("diffNotes", () => {
  it("counts additions and removals", () => {
    const d = diffNotes([note(60, 0)], [note(60, 0), note(64, 1)]);
    expect(d).toEqual({ added: 1, removed: 0 });
  });
});

describe("NoteTracker", () => {
  it("reports a change when notes change within one clip", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    const r = t.update("2:0", [note(60, 0), note(67, 2)]);
    expect(r.changed).toBe(true);
    expect(r.added).toBe(1);
  });

  it("reports no change when the same notes are polled twice", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    expect(t.update("2:0", [note(60, 0)]).changed).toBe(false);
  });

  it("does not report a phantom edit when the focused clip changes", () => {
    // Selecting a different clip must reset the baseline. Otherwise the very
    // different note set of the new clip reads as a huge edit that never
    // happened, and that lands in the observation log as a lie.
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    const r = t.update("3:1", [note(48, 0), note(50, 1), note(52, 2)]);
    expect(r.changed).toBe(false);
  });

  it("resumes reporting changes after the reset", () => {
    const t = new NoteTracker();
    t.update("2:0", [note(60, 0)]);
    t.update("3:1", [note(48, 0)]);
    expect(t.update("3:1", [note(48, 0), note(55, 1)]).changed).toBe(true);
  });
});
