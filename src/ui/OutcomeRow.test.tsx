// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OutcomeRow } from "./OutcomeRow";
import { Outcome } from "../notes/outcomes";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

const exchange = { turnId: "t1", move: "«Pad», mud: cut 300 Hz", answer: "Cut it.", tracksRead: ["Pad"] };
let last: Outcome[] = [];
function Harness({ sharing = false, onSkip, onDone }: { sharing?: boolean; onSkip?: () => void; onDone?: () => void }) {
  const [log, setLog] = useState<Outcome[]>([]);
  return <OutcomeRow exchange={exchange} outcomes={log} sharingEnabled={sharing}
    onChange={(next) => { last = next; setLog(next); return true; }} onSkip={onSkip} onDone={onDone} />;
}
const kept = () => screen.getByRole("button", { name: "Kept it" });
const undid = () => screen.getByRole("button", { name: "Undid it" });

it("highlights a tap and opens an unfocused heard field after Kept", () => {
  render(<Harness />);
  fireEvent.click(kept());
  const field = screen.getByLabelText("What did you hear?");
  expect(document.activeElement).not.toBe(field);
  fireEvent.keyDown(field, { key: "Escape" });
  expect(kept().getAttribute("aria-pressed")).toBe("true");
});

it("focuses the heard field after Undid and saves it on Enter", async () => {
  render(<Harness />);
  fireEvent.click(undid());
  const field = screen.getByLabelText("What did you hear?");
  await waitFor(() => expect(document.activeElement).toBe(field));
  fireEvent.change(field, { target: { value: "sounded thin" } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(last[last.length - 1]).toMatchObject({ outcome: "undone", heard: "sounded thin" });
  expect(screen.queryByLabelText("What did you hear?")).toBeNull();
  expect(screen.getByRole("button", { name: "Undid it" })).toBeTruthy();
});

it("closes the heard field on Escape without saving", () => {
  render(<Harness />);
  fireEvent.click(undid());
  const field = screen.getByLabelText("What did you hear?");
  fireEvent.change(field, { target: { value: "draft" } });
  fireEvent.keyDown(field, { key: "Escape" });
  expect(last[last.length - 1]?.heard).toBe("");
  expect(screen.queryByLabelText("What did you hear?")).toBeNull();
});

it("clears the rating when the highlighted choice is tapped again", () => {
  render(<Harness />);
  fireEvent.click(kept());
  fireEvent.keyDown(screen.getByLabelText("What did you hear?"), { key: "Escape" });
  fireEvent.click(kept());
  expect(last).toEqual([]);
  expect(kept().getAttribute("aria-pressed")).toBe("false");
});

it("shares a rating only when sharing is on", async () => {
  vi.mocked(invoke).mockResolvedValue({ saved: true });
  render(<Harness />);
  fireEvent.click(kept());
  expect(invoke).not.toHaveBeenCalled();
  cleanup();
  render(<Harness sharing />);
  fireEvent.click(kept());
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("turn_feedback", expect.objectContaining({
    turnId: "t1", feedback: expect.objectContaining({ outcome: "kept", heard: "" }),
  })));
});

it("says so when a share fails, and keeps the local rating", async () => {
  vi.mocked(invoke).mockRejectedValue({ message: "offline" });
  render(<Harness sharing />);
  fireEvent.click(kept());
  await screen.findByText("Couldn't share this outcome.");
  expect(last[last.length - 1]?.outcome).toBe("kept");
});

it("shares the heard text even when it is saved before the first share returns", async () => {
  let release: (value: unknown) => void = () => {};
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }))
    .mockResolvedValue({ saved: true });
  render(<Harness sharing />);
  fireEvent.click(undid());
  const field = screen.getByLabelText("What did you hear?");
  fireEvent.change(field, { target: { value: "sounded thin" } });
  fireEvent.keyDown(field, { key: "Enter" });
  release({ saved: true });
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("turn_feedback", expect.objectContaining({
    feedback: expect.objectContaining({ outcome: "undone", heard: "sounded thin" }),
  })));
  expect(screen.queryByText("Couldn't share this outcome.")).toBeNull();
});

it("saves typed heard text when the producer clicks away", () => {
  render(<Harness />);
  fireEvent.click(kept());
  const field = screen.getByLabelText("What did you hear?");
  fireEvent.change(field, { target: { value: "tighter now" } });
  fireEvent.blur(field);
  expect(last[last.length - 1]).toMatchObject({ outcome: "kept", heard: "tighter now" });
});

it("saves with the Save button and says which choice it is about", () => {
  const done = vi.fn();
  render(<Harness onDone={done} />);
  fireEvent.click(kept());
  expect(screen.getByText("Kept it. What did you hear?")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("What did you hear?"), { target: { value: "wider" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(last[last.length - 1]).toMatchObject({ heard: "wider" });
  expect(done).toHaveBeenCalledTimes(1);
});

it("keeps saved heard text when Escape closes a later edit", () => {
  render(<Harness />);
  fireEvent.click(kept());
  const field = screen.getByLabelText("What did you hear?");
  fireEvent.change(field, { target: { value: "first" } });
  fireEvent.keyDown(field, { key: "Enter" });
  fireEvent.click(kept());   // clears the rating
  fireEvent.click(kept());   // rates again, heard starts empty
  const again = screen.getByLabelText("What did you hear?");
  fireEvent.change(again, { target: { value: "should not save" } });
  fireEvent.keyDown(again, { key: "Escape" });
  expect(last[last.length - 1].heard).toBe("");
});

it("offers Didn't try only when asked, and it records nothing", () => {
  const { unmount } = render(<Harness />);
  expect(screen.queryByRole("button", { name: "Didn't try" })).toBeNull();
  unmount();
  last = [];
  const skip = vi.fn();
  render(<Harness onSkip={skip} />);
  fireEvent.click(screen.getByRole("button", { name: "Didn't try" }));
  expect(skip).toHaveBeenCalledTimes(1);
  expect(last).toEqual([]);
});

it("is done after clearing a rating", () => {
  const done = vi.fn();
  render(<Harness onDone={done} />);
  fireEvent.click(kept());
  fireEvent.keyDown(screen.getByLabelText("What did you hear?"), { key: "Escape" });
  fireEvent.click(kept());
  expect(done).toHaveBeenCalledTimes(2);
});

it("keeps Escape in the heard field from closing the card", () => {
  const card = vi.fn();
  window.addEventListener("keydown", card);
  render(<Harness />);
  fireEvent.click(kept());
  fireEvent.keyDown(screen.getByLabelText("What did you hear?"), { key: "Escape" });
  window.removeEventListener("keydown", card);
  expect(card).not.toHaveBeenCalled();
});
