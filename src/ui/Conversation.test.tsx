// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Conversation } from "./Conversation";
import { SWITCH_HOLD_MS } from "./threadStore";
import { flushThreadSaves, lockThreadSaves } from "../model/threads";
import { emptySet } from "../live/apply";
import { AccountState } from "../model/account";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const account: AccountState = {
  view: { access: "development", capture: false },
  error: null, refresh: async () => {}, change: () => {}, observe: () => () => {},
};
beforeEach(() => {
  vi.useFakeTimers();
  lockThreadSaves(false);
  vi.mocked(invoke).mockReset();
});
afterEach(async () => {
  cleanup();
  vi.mocked(invoke).mockResolvedValue(undefined);
  await flushThreadSaves();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([
  { setId: "original", setPath: "/new.als" },
  { setId: "adopted", setPath: "/old.als" },
])("supersedes the displayed thread's failed save when Live rekeys to $setId at $setPath", async (next) => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(invoke).mockResolvedValue(null);
  let state = { ...emptySet(), setId: "original", setPath: "/old.als" };
  const conversation = () => <Conversation state={state} connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />;
  const mounted = render(conversation());
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  fireEvent.change(screen.getByLabelText("Goal (optional)"), { target: { value: "new goal" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Start chatting" })); });
  expect(screen.getByText(/Could not save this set's thread/)).toBeTruthy();

  state = { ...state, ...next };
  await act(async () => { mounted.rerender(conversation()); });
  expect(invoke).toHaveBeenLastCalledWith("save_thread", expect.objectContaining({ setId: next.setId, setPath: next.setPath, goal: "new goal" }));
  expect(screen.queryByText(/Could not save this set's thread/)).toBeNull();
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).not.toHaveBeenCalled();
});
