// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { Conversation } from "./Conversation";
import { SWITCH_HOLD_MS } from "./threadStore";
import { flushThreadSaves, lockThreadSaves } from "../model/threads";
import { emptySet } from "../live/apply";
import { emptyTrack } from "../live/model";
import { BusyContext, createBusyState, installWhenIdle } from "../model/updates";
import { AccountState } from "../model/account";
import wireVersion from "../../shared/wire-version.json";

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
  localStorage.removeItem("copilot.notesOpen");
  vi.mocked(invoke).mockResolvedValue(undefined);
  await flushThreadSaves();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("keeps the chat visible during a pause and enables its draft when service resumes", async () => {
  vi.mocked(invoke).mockResolvedValue({ exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] });
  let current: AccountState = { ...account, view: { access: "active", capture: false, can_ask: false, service_paused: true, remaining_micro_usd: 5_000_000 } };
  const conversation = () => <Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }}
    connected account={current} onTurnRunningChange={() => {}} onAnswer={() => {}} />;
  const mounted = render(conversation());
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  const input = screen.getByLabelText("Ask about the set") as HTMLInputElement;
  expect(input.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toBe("Model access is temporarily paused.");
  current = { ...current, view: { ...current.view!, can_ask: true, service_paused: false } };
  mounted.rerender(conversation());
  expect(input.disabled).toBe(false);
  expect(screen.queryByText("Model access is temporarily paused.")).toBeNull();
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

it.each(["add", "edit"])("keeps a rejected note %s draft until installation fails and she retries", async (action) => {
  localStorage.setItem("copilot.notesOpen", "1");
  const busy = createBusyState();
  let rejectInstall!: (reason: Error) => void;
  const installation = new Promise<void>((_, reject) => { rejectInstall = reject; });
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "install_update") return installation;
    if (command === "load_thread") return {
      exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 2,
      note: [{ id: "b1", kind: "heard", text: "Original note", at: 1, hers: true }],
    };
  });
  render(<BusyContext.Provider value={busy}><Conversation
    state={{ ...emptySet(), setId: "set", setPath: "/set.als" }} connected account={account}
    onTurnRunningChange={() => {}} onAnswer={() => {}}
  /></BusyContext.Provider>);
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  if (action === "edit") fireEvent.click(screen.getByRole("button", { name: "Original note" }));
  const input = action === "add" ? screen.getByPlaceholderText("Add a note…") : screen.getByDisplayValue("Original note");
  fireEvent.change(input, { target: { value: "Keep this draft" } });
  let installing!: Promise<unknown>;
  await act(async () => { installing = installWhenIdle(busy).catch((error) => error); });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByDisplayValue("Keep this draft")).toBe(input);
  expect(invoke).not.toHaveBeenCalledWith("save_thread", expect.anything());
  await act(async () => { rejectInstall(new Error("offline")); await installing; });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  expect(screen.getByRole("button", { name: "Keep this draft" })).toBeTruthy();
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({
    note: expect.arrayContaining([expect.objectContaining({ text: "Keep this draft" })]),
  }));
});

it("lists what the model has read while she waits, and clears the list when the answer lands", async () => {
  let finishTool!: () => void;
  const toolResult = new Promise<unknown>((resolve) => { finishTool = () => resolve({ value: [] }); });
  const call = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  let rounds = 0;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "load_thread") return { exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] };
    if (command === "model_complete") {
      return rounds++ === 0
        ? { text: "", tool_calls: [call("a", "get_arrangement", {}), call("b", "get_clip_notes", { track: 0, clip: 0 })] }
        : { text: "The pad is fine." };
    }
    if (command === "execute_tool") {
      return (args as { name: string }).name === "get_arrangement" ? { value: [] } : toolResult;
    }
  });
  const state = { ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version, tracks: { 0: { ...emptyTrack(), name: "Pad" } } };
  render(<Conversation state={state} connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />);
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  const input = screen.getByLabelText("Ask about the set");
  fireEvent.change(input, { target: { value: "How is the pad?" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual([
    "✓mapped the arrangement",
    "reading the notes in Pad…",
  ]);
  expect(screen.getByText("Thinking… 2 reads so far")).toBeTruthy();

  await act(async () => { finishTool(); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText("The pad is fine.")).toBeTruthy();
  expect(screen.queryAllByRole("listitem")).toEqual([]);
});

async function answered(move = "«Pad», mud: cut 300 Hz") {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "load_thread") return { exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] };
    if (command === "model_complete") return { text: `Cut it.\n\`\`\`move\n${move}\n\`\`\`` };
  });
  const state = { ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version, tracks: { 0: { ...emptyTrack(), name: "Pad" } } };
  render(<Conversation state={state} connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />);
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  const input = screen.getByLabelText("Ask about the set");
  fireEvent.change(input, { target: { value: "How is the pad?" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  return input;
}
const strip = () => screen.queryByRole("region", { name: "How did the last move go?" });

it("waits until she comes back before asking how the move went", async () => {
  const input = await answered();
  expect(screen.getByText("Cut it.")).toBeTruthy();
  expect(strip()).toBeNull();
  fireEvent.focus(input);
  expect(strip()).toBeTruthy();
});

it("asks when the window regains focus", async () => {
  await answered();
  act(() => { window.dispatchEvent(new Event("focus")); });
  expect(strip()).toBeTruthy();
});

it("lets her skip the check-in, and does not ask again for that move", async () => {
  const input = await answered();
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole("button", { name: "Didn't try" }));
  expect(strip()).toBeNull();
  fireEvent.focus(input);
  expect(strip()).toBeNull();
});

it("tucks the check-in away when she asks the next question", async () => {
  const input = await answered();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "And the drums?" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  expect(strip()).toBeNull();
});

it("changes a rating from the answer's menu", async () => {
  await answered();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Change how it went" }));
  expect(screen.getByRole("button", { name: "Kept it" })).toBeTruthy();
});

it("asks when she clicks into an input that already has focus", async () => {
  const input = await answered();
  input.focus();
  expect(strip()).toBeNull();
  fireEvent.click(input);
  expect(strip()).toBeTruthy();
});

it("puts focus on the choices after Change how it went", async () => {
  await answered();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Change how it went" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Kept it" }));
});

it("shows one set of choices when she edits the move the check-in would ask about", async () => {
  const input = await answered();
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Change how it went" }));
  fireEvent.click(input);
  expect(screen.getAllByRole("button", { name: "Kept it" })).toHaveLength(1);
});

it("forgets an open check-in when the set changes", async () => {
  const saved: Record<string, unknown> = {};
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const a = args as { setId: string; exchanges: unknown; goal: unknown; note: unknown; nextBullet: unknown; outcomes: unknown };
    if (command === "load_thread") return saved[a.setId] ?? { exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] };
    if (command === "save_thread") {
      saved[a.setId] = { exchanges: a.exchanges, goal: a.goal, saved_at: 1, next_bullet: a.nextBullet, note: a.note, outcomes: a.outcomes };
      return;
    }
    if (command === "model_complete") return { text: "Cut it.\n```move\n«Pad», mud: cut 300 Hz\n```" };
  });
  const base = { ...emptySet(), scriptVersion: wireVersion.version, tracks: { 0: { ...emptyTrack(), name: "Pad" } } };
  const setA = { ...base, setId: "A", setPath: "/a.als" };
  const setB = { ...base, setId: "B", setPath: "/b.als" };
  const view = (state: typeof setA) => <Conversation state={state} connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />;
  const { rerender } = render(view(setA));
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  const input = screen.getByLabelText("Ask about the set");
  fireEvent.change(input, { target: { value: "How is the pad?" } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  await act(() => vi.advanceTimersByTimeAsync(0));
  fireEvent.click(screen.getByLabelText("Ask about the set"));
  expect(strip()).toBeTruthy();
  rerender(view(setB));
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  expect(strip()).toBeNull();
  rerender(view(setA));
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  expect(screen.getByText("Cut it.")).toBeTruthy();
  expect(strip()).toBeNull();
  fireEvent.click(screen.getByLabelText("Ask about the set"));
  expect(strip()).toBeTruthy();
});
