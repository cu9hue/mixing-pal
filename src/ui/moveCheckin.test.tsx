// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { MoveBox } from "./MoveBox";
import { MoveCheckin } from "./MoveCheckin";
import { AnswerMenu } from "./AnswerMenu";
import { Outcome } from "../notes/outcomes";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(cleanup);

const exchange = { turnId: "t1", move: "«Clap» + «Closed Hat»: duplicate bars 9-16 to 17-24", answer: "Do it.", tracksRead: [] };
const rated = (heard = ""): Outcome => ({ turnId: "t1", move: exchange.move, outcome: "undone", heard, tracks: [], answer: "Do it.", at: 1 });

it("shows the move, and the result once rated", () => {
  const { rerender } = render(<MoveBox exchange={exchange} outcomes={[]} editing={false} sharingEnabled={false} onChange={() => true} onDone={() => {}} />);
  expect(screen.getByText("Your move")).toBeTruthy();
  expect(screen.getByText(exchange.move)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Kept it" })).toBeNull();
  rerender(<MoveBox exchange={exchange} outcomes={[rated("too busy")]} editing={false} sharingEnabled={false} onChange={() => true} onDone={() => {}} />);
  expect(screen.getByText("Undid it · “too busy”")).toBeTruthy();
});

it("offers the three choices inside the box while editing", () => {
  render(<MoveBox exchange={exchange} outcomes={[rated()]} editing sharingEnabled={false} onChange={() => true} onDone={() => {}} />);
  expect(screen.getByRole("button", { name: "Undid it" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "Didn't try" })).toBeTruthy();
});

it("in the box, Didn't try clears the rating and closes", () => {
  let log: Outcome[] = [rated()];
  const done = vi.fn();
  render(<MoveBox exchange={exchange} outcomes={log} editing sharingEnabled={false} onChange={(n) => { log = n; return true; }} onDone={done} />);
  fireEvent.click(screen.getByRole("button", { name: "Didn't try" }));
  expect(log).toEqual([]);
  expect(done).toHaveBeenCalledTimes(1);
});

function Strip({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<Outcome[]>([]);
  return <MoveCheckin exchange={exchange} outcomes={log} sharingEnabled={false} onChange={(n) => { setLog(n); return true; }} onClose={onClose} />;
}

it("asks how the last move went, and closes after the heard step", () => {
  const close = vi.fn();
  render(<Strip onClose={close} />);
  expect(screen.getByRole("region", { name: "How did the last move go?" })).toBeTruthy();
  expect(screen.getByText(exchange.move)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Kept it" }));
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByLabelText("What did you hear?"), { key: "Enter" });
  expect(close).toHaveBeenCalledTimes(1);
});

it("closes on Didn't try", () => {
  const close = vi.fn();
  render(<Strip onClose={close} />);
  fireEvent.click(screen.getByRole("button", { name: "Didn't try" }));
  expect(close).toHaveBeenCalledTimes(1);
});

it("opens a menu with both actions for an answer with a move", () => {
  const change = vi.fn(); const report = vi.fn();
  render(<AnswerMenu canChange disabled={false} onChangeOutcome={change} onReport={report} />);
  const button = screen.getByRole("button", { name: "More actions" });
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Change how it went" }));
  expect(change).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("menu")).toBeNull();
  fireEvent.click(button);
  fireEvent.click(screen.getByRole("menuitem", { name: "Report a problem" }));
  expect(report).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button);
});

it("offers only a report on a turn with no move, and closes on Escape", () => {
  render(<AnswerMenu canChange={false} disabled={false} onChangeOutcome={() => {}} onReport={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  expect(screen.queryByRole("menuitem", { name: "Change how it went" })).toBeNull();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});

it("keeps Escape in the menu from closing the card", () => {
  const card = vi.fn();
  window.addEventListener("keydown", card);
  render(<AnswerMenu canChange disabled={false} onChangeOutcome={() => {}} onReport={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  window.removeEventListener("keydown", card);
  expect(card).not.toHaveBeenCalled();
});
