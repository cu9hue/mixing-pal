// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  expect(screen.getByRole("status").textContent).toBe("Model access is paused on our side. Try again later.");
  expect(screen.queryByRole("button", { name: "Open Settings" })).toBeNull();
  current = { ...current, view: { ...current.view!, can_ask: true, service_paused: false } };
  mounted.rerender(conversation());
  expect(input.disabled).toBe(false);
  expect(screen.queryByText("Model access is paused on our side. Try again later.")).toBeNull();
});

it.each([
  [{ subscription_status: "trialing", plan: "starter" }, "Your trial usage is used up."],
  [{ subscription_status: "active", plan: "starter" }, "This month's usage is used up."],
  [{}, "Your pilot usage is used up."],
] as const)("when usage runs out, says so and opens Settings from the line itself", async (sub, line) => {
  vi.mocked(invoke).mockResolvedValue({ exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] });
  const onOpenSettings = vi.fn();
  const used: AccountState = { ...account, view: { access: "active", capture: false, can_ask: false, remaining_micro_usd: 100, ...sub } };
  render(<Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }}
    connected account={used} onTurnRunningChange={() => {}} onAnswer={() => {}} onOpenSettings={onOpenSettings} />);
  await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  expect(screen.getByRole("status").textContent).toBe(`${line} Open Settings`);
  fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
  expect(onOpenSettings).toHaveBeenCalledTimes(1);
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

it.each(["add", "edit"])("keeps a rejected note %s draft until installation fails and the producer retries", async (action) => {
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

it("lists what the model has read while the producer waits, and clears the list when the answer lands", async () => {
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

it("waits until the producer comes back before asking how the move went", async () => {
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

it("lets the producer skip the check-in, and does not ask again for that move", async () => {
  const input = await answered();
  fireEvent.focus(input);
  fireEvent.click(screen.getByRole("button", { name: "Didn't try" }));
  expect(strip()).toBeNull();
  fireEvent.focus(input);
  expect(strip()).toBeNull();
});

it("tucks the check-in away when the producer asks the next question", async () => {
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

it("asks when the producer clicks into an input that already has focus", async () => {
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

it("shows one set of choices when the producer edits the move the check-in would ask about", async () => {
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
      // Rust stamps the save with its own clock.
      saved[a.setId] = { exchanges: a.exchanges, goal: a.goal, saved_at: Math.floor(Date.now() / 1000), next_bullet: a.nextBullet, note: a.note, outcomes: a.outcomes };
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

describe("returning to a set", () => {
  const SAVED = 1_000_000;
  const exchanges = [
    { question: "What's on the Bass chain?", answer: "First answer.", error: null, turnId: "t1", move: "Cut 200 Hz on the bass" },
    { question: "What should I work on next?", answer: "Second answer.", error: null, turnId: "t2", move: "Shorten the kick tail" },
  ];
  const outcomes = [{ turnId: "t2", move: "Shorten the kick tail", outcome: "kept", heard: "tighter", tracks: [], answer: "", at: SAVED }];
  async function open(savedAt: number, now: number, log: unknown[] = outcomes) {
    vi.setSystemTime(now * 1000);
    vi.mocked(invoke).mockImplementation(async (command) => command === "load_thread"
      ? { exchanges, goal: "finish this track", saved_at: savedAt, next_bullet: 1,
          note: [{ id: "b0", kind: "decided", text: "Keep the vocal dry", at: SAVED, hers: true }], outcomes: log }
      : undefined);
    render(<Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }} connected account={account}
      onTurnRunningChange={() => {}} onAnswer={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
  }

  it("after a break, shows a recap in place of the earlier answers until the producer unfolds them", async () => {
    await open(SAVED, SAVED + 2 * 24 * 60 * 60);
    const recap = screen.getByRole("region", { name: "Last time" });
    expect(recap.textContent).toContain("2 days ago");
    expect(recap.textContent).toContain("What should I work on next?");
    expect(recap.textContent).toContain("Shorten the kick tail");
    expect(recap.textContent).toContain("tighter");
    expect(recap.textContent).toContain("Keep the vocal dry");
    expect(screen.queryByText("First answer.")).toBeNull();
    expect(screen.queryByText("Second answer.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 earlier answers" }));
    expect(screen.getByText("First answer.")).toBeTruthy();
    expect(screen.getByText("Second answer.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Last time" })).toBeTruthy();
  });

  it("dismisses the recap and keeps the fold", async () => {
    await open(SAVED, SAVED + 2 * 24 * 60 * 60);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the recap" }));
    expect(screen.queryByRole("region", { name: "Last time" })).toBeNull();
    expect(screen.getByRole("button", { name: "Show 2 earlier answers" })).toBeTruthy();
    expect(screen.queryByText("First answer.")).toBeNull();
  });

  it("leaves an unrated newest move to the check-in", async () => {
    await open(SAVED, SAVED + 2 * 24 * 60 * 60, []);
    expect(screen.getByRole("region", { name: "Last time" }).textContent).not.toContain("Shorten the kick tail");
    fireEvent.click(screen.getByLabelText("Ask about the set"));
    expect(screen.getByRole("region", { name: "How did the last move go?" })).toBeTruthy();
  });

  it("without a break, shows the full thread as before", async () => {
    await open(SAVED, SAVED + 60 * 60);
    expect(screen.queryByRole("region", { name: "Last time" })).toBeNull();
    expect(screen.getByText("First answer.")).toBeTruthy();
    expect(screen.getByText(/Earlier on this set · 2 exchanges/)).toBeTruthy();
  });
});

describe("reporting a problem", () => {
  async function ask(reply: () => Promise<unknown>) {
    const onReport = vi.fn();
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "load_thread") return null;
      if (command === "model_complete") return reply();
    });
    render(<Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }} connected account={account}
      onTurnRunningChange={() => {}} onAnswer={() => {}} onReport={onReport} />);
    await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
    fireEvent.click(screen.getByRole("button", { name: "Start chatting" }));
    return onReport;
  }
  async function send(question: string) {
    const input = screen.getByLabelText("Ask about the set");
    fireEvent.change(input, { target: { value: question } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(() => vi.advanceTimersByTimeAsync(0));
  }

  it("offers a report from the footer before anything is asked, with no conversation", async () => {
    const onReport = await ask(async () => ({ text: "Fine." }));
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(onReport).toHaveBeenCalledWith({ origin: "settings" });
  });

  it("reports the newest answer from the footer", async () => {
    const onReport = await ask(async () => ({ text: "Fine." }));
    await send("How is the pad?");
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    expect(onReport).toHaveBeenCalledWith({ origin: "answer", exchange: expect.objectContaining({ question: "How is the pad?", answer: "Fine." }) });
  });

  it("puts a report link right under a failed answer", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const onReport = await ask(async () => { throw { code: "completion_interrupted", message: "The reply was interrupted." }; });
    await send("How is the pad?");
    fireEvent.click(screen.getByRole("button", { name: "Report this" }));
    expect(onReport).toHaveBeenCalledWith({ origin: "error", exchange: expect.objectContaining({ question: "How is the pad?" }) });
  });
});

describe("terms the producer can tap", () => {
  const reply = "**Lower the Threshold.** Watch the gain reduction and the make-up gain.\n\n"
    + "```terms\nGain reduction: How far the Compressor turns the signal down.\nMake-up gain: Volume added back after the Compressor.\nSidechain: Not in the prose.\n```";
  async function ask(text: string) {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "load_thread") return { exchanges: [], goal: "finish this track", saved_at: 1, next_bullet: 1, note: [] };
      if (command === "model_complete") return { text };
    });
    render(<Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }}
      connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
    const input = screen.getByLabelText("Ask about the set");
    fireEvent.change(input, { target: { value: "What is the compressor doing?" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await act(() => vi.advanceTimersByTimeAsync(0));
  }

  it("marks each listed term in the prose and hides the block", async () => {
    await ask(reply);
    const gain = screen.getByRole("button", { name: "gain reduction" });
    expect(gain.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "make-up gain" })).toBeTruthy();
    // Listed but not in the prose: in the row at the end, not in the text.
    expect(screen.getByRole("button", { name: "Sidechain" }).closest("p")?.textContent).toBe("Terms: Sidechain");
    expect(screen.queryByText(/```terms/)).toBeNull();
    expect(screen.queryByRole("note")).toBeNull();
    expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({
      exchanges: [expect.objectContaining({
        answer: "**Lower the Threshold.** Watch the gain reduction and the make-up gain.",
        terms: expect.arrayContaining([{ term: "Gain reduction", meaning: "How far the Compressor turns the signal down." }]),
      })],
    }));
  });

  it("opens one plain line under the paragraph, one at a time, and closes it on Esc or a second tap", async () => {
    await ask(reply);
    const gain = screen.getByRole("button", { name: "gain reduction" });
    const makeUp = screen.getByRole("button", { name: "make-up gain" });
    fireEvent.click(gain);
    const line = screen.getByRole("note");
    expect(line.textContent).toBe("Gain reduction: How far the Compressor turns the signal down.");
    expect(line.querySelector("strong")?.textContent).toBe("Gain reduction");
    expect(gain.getAttribute("aria-expanded")).toBe("true");
    expect(gain.getAttribute("aria-controls")).toBe(line.id);
    expect(gain.closest("p")?.nextElementSibling).toBe(line);

    fireEvent.click(makeUp);
    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note").textContent).toBe("Make-up gain: Volume added back after the Compressor.");
    expect(gain.getAttribute("aria-expanded")).toBe("false");

    fireEvent.keyDown(makeUp, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(gain);
    fireEvent.click(gain);
    expect(screen.queryByRole("note")).toBeNull();
  });

  // WebKit on macOS does not focus a button on click, and App collapses the
  // card on any Escape that reaches the window.
  it("takes focus on a tap, and closes the line on Esc without collapsing the card", async () => {
    await ask(reply);
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      const gain = screen.getByRole("button", { name: "gain reduction" });
      fireEvent.click(gain);
      expect(document.activeElement).toBe(gain);
      fireEvent.keyDown(gain, { key: "Escape" });
      expect(screen.queryByRole("note")).toBeNull();
      expect(windowEscape).not.toHaveBeenCalled();
      // With no line open, Esc still reaches the card.
      fireEvent.keyDown(gain, { key: "Escape" });
      expect(windowEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("makes a fenced name tappable when it is the whole term, and keeps the chip", async () => {
    await ask("Raise «Threshold» a little.\n\n```terms\n«Threshold»: The level where the Compressor starts to act.\n```");
    const chip = screen.getByRole("button", { name: "Threshold" });
    expect(chip.className).toBe("card__fence card__term");
    fireEvent.click(chip);
    expect(screen.getByRole("note").textContent).toBe("Threshold: The level where the Compressor starts to act.");
  });

  it("restores the terms of a saved answer", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "load_thread") return {
        exchanges: [{ question: "What is the compressor doing?", answer: "Watch the gain reduction.", error: null, turnId: "t1",
          terms: [{ term: "Gain reduction", meaning: "How far the Compressor turns the signal down." }] }],
        goal: "finish this track", saved_at: Math.floor(Date.now() / 1000), next_bullet: 1, note: [], outcomes: [],
      };
    });
    render(<Conversation state={{ ...emptySet(), setId: "set", setPath: "/set.als", scriptVersion: wireVersion.version }}
      connected account={account} onTurnRunningChange={() => {}} onAnswer={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(SWITCH_HOLD_MS));
    fireEvent.click(screen.getByRole("button", { name: "gain reduction" }));
    expect(screen.getByRole("note").textContent).toBe("Gain reduction: How far the Compressor turns the signal down.");
  });

  it("puts a term the prose does not use in a row at the end, and opens its line under that row", async () => {
    const text = "Watch the knee.\n\n```terms\nKnee: How gently it starts.\nSidechain: Another signal decides when it acts.\n```";
    await ask(text);
    const knee = screen.getByRole("button", { name: "knee" });
    const sidechain = screen.getByRole("button", { name: "Sidechain" });
    const row = sidechain.closest("p")!;
    expect(row.textContent).toBe("Terms: Sidechain");
    expect(knee.closest("p")).not.toBe(row);

    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      fireEvent.click(sidechain);
      expect(document.activeElement).toBe(sidechain);
      expect(sidechain.getAttribute("aria-expanded")).toBe("true");
      const line = screen.getByRole("note");
      expect(line.textContent).toBe("Sidechain: Another signal decides when it acts.");
      expect(sidechain.getAttribute("aria-controls")).toBe(line.id);
      expect(row.nextElementSibling).toBe(line);

      fireEvent.click(knee);
      expect(screen.getAllByRole("note")).toHaveLength(1);
      expect(sidechain.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(sidechain);
      fireEvent.keyDown(sidechain, { key: "Escape" });
      expect(screen.queryByRole("note")).toBeNull();
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("shows no row when every term is in the prose", async () => {
    await ask("Watch the knee.\n\n```terms\nKnee: How gently it starts.\n```");
    expect(screen.getByRole("button", { name: "knee" })).toBeTruthy();
    expect(screen.queryByText(/^Terms:/)).toBeNull();
  });

  it("renders an answer without terms as before", async () => {
    await ask("Leave the gain reduction alone.");
    expect(screen.getByText("Leave the gain reduction alone.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "gain reduction" })).toBeNull();
    expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({
      exchanges: [expect.not.objectContaining({ terms: expect.anything() })],
    }));
  });
});
