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
function Harness({ sharing = false }: { sharing?: boolean }) {
  const [log, setLog] = useState<Outcome[]>([]);
  return <OutcomeRow exchange={exchange} outcomes={log} sharingEnabled={sharing} sentCount={1}
    onChange={(next) => { last = next; setLog(next); return true; }} />;
}
const kept = () => screen.getByRole("button", { name: "Kept it" });
const undid = () => screen.getByRole("button", { name: "Undid it" });

it("highlights a tap and opens an unfocused heard field after Kept", () => {
  render(<Harness />);
  fireEvent.click(kept());
  expect(kept().getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).not.toBe(screen.getByLabelText("What did you hear?"));
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
  expect(screen.getByRole("button", { name: "“sounded thin”" })).toBeTruthy();
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
