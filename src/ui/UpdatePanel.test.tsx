// @vitest-environment jsdom
import { Conversation } from "./Conversation";
import { emptySet } from "../live/apply";
import wireVersion from "../../shared/wire-version.json";
import { FeedbackPanel } from "./FeedbackPanel";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UpdatePanel } from "./UpdatePanel";
import { BusyContext, createBusyState, useUpdates, installWhenIdle } from "../model/updates";
import { lockThreadSaves } from "../model/threads";
import { Advanced } from "./Advanced";
import { InstallScreen } from "../setup/screens";
import { AccountPanel } from "./AccountPanel";
import { AccountState } from "../model/account";
import { invoke } from "@tauri-apps/api/core";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeEach(() => lockThreadSaves(false));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });
it("downloads only on request and requires a separate explicit restart", async () => {
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    commands.push(cmd);
    return { channel: "stable", phase: cmd === "download_update" ? "ready" : "available", version: "99.0.0", notes: "<b>Release notes</b>" };
  });
  const busy = createBusyState();
  function App() { const updates = useUpdates(busy); return <BusyContext.Provider value={busy}><UpdatePanel updates={updates} /></BusyContext.Provider>; }
  render(<App />);
  fireEvent.click(await screen.findByRole("button", { name: "Download update" }));
  expect(await screen.findByText("<b>Release notes</b>")).toBeTruthy();
  const install = await screen.findByRole("button", { name: "Install and restart Mixing Pal" });
  expect(commands).toEqual(["check_update", "download_update"]);
  busy.turn = true;
  fireEvent.click(install);
  expect(await screen.findByText(/Finish the current/)).toBeTruthy();
  expect(commands).not.toContain("install_update");
  busy.turn = false;
  fireEvent.click(install);
  await waitFor(() => expect(commands).toContain("install_update"));
});
it("checks manually after an error and discards a pending download on channel change", async () => {
  vi.mocked(invoke).mockRejectedValueOnce("offline").mockResolvedValue({ channel: "stable", phase: "ready", version: "99.0.0" });
  const busy = createBusyState();
  function App() { const updates = useUpdates(busy); return <UpdatePanel updates={updates} />; }
  render(<App />);
  expect(await screen.findByText("offline")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
  await screen.findByRole("button", { name: "Install and restart Mixing Pal" });
  vi.mocked(invoke).mockResolvedValue({ channel: "pilot", phase: "idle" });
  fireEvent.click(screen.getByLabelText("Receive pilot updates"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Install and restart Mixing Pal" })).toBeNull());
  expect(invoke).toHaveBeenCalledWith("set_update_channel", { channel: "pilot" });
});

const account: AccountState = {
  view: { access: "active", capture: false, email: "test@example.test", remaining_micro_usd: 1 },
  error: null, refresh: async () => {}, change: () => {}, observe: () => () => {},
};
const development: AccountState = { ...account, view: { access: "development", capture: false } };
const deferred = () => { let resolve!: (value?: unknown) => void; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
it.each(["setup", "reinstall", "settings", "account"] as const)("blocks install while the real %s control awaits its command", async (kind) => {
  const pending = deferred();
  const target = kind === "settings" ? "save_settings" : kind === "account" ? "account_sign_out" : "install_connector";
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    commands.push(cmd);
    if (cmd === target) return pending.promise;
    if (cmd === "get_settings") return { base_url: "http://localhost", model: "test", has_key: false };
    if (cmd === "connector_status") return { folder: "MixingPal", installed: true };
  });
  const busy = createBusyState();
  render(<BusyContext.Provider value={busy}>
    {kind === "setup" ? <InstallScreen folder="MixingPal" onInstalled={() => {}} />
      : kind === "account" ? <AccountPanel account={account} />
      : <Advanced account={development} scriptVersion={12} onClose={() => {}} />}
  </BusyContext.Provider>);
  const label = { setup: "Install it", reinstall: "Reinstall", settings: "Save", account: "Sign out" }[kind];
  const button = await screen.findByRole("button", { name: label });
  fireEvent.click(button);
  await expect(installWhenIdle(busy)).rejects.toThrow("Finish");
  expect(commands).not.toContain("install_update");
  pending.resolve({ base_url: "http://localhost", model: "test", has_key: false });
  await waitFor(() => expect(busy.wireInstall || busy.settingsSave || busy.accountMutation).toBe(false));
  expect(commands).not.toContain("install_update");
  await installWhenIdle(busy);
  expect(commands).toContain("install_update");
});
it.each(["setup", "reinstall", "settings", "account"] as const)("refuses a new %s mutation after installation is pending", async (kind) => {
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    commands.push(cmd);
    if (cmd === "get_settings") return { base_url: "http://localhost", model: "test", has_key: false };
    if (cmd === "connector_status") return { folder: "MixingPal", installed: true };
  });
  const busy = createBusyState(); busy.install = true;
  render(<BusyContext.Provider value={busy}>
    {kind === "setup" ? <InstallScreen folder="MixingPal" onInstalled={() => {}} />
      : kind === "account" ? <AccountPanel account={account} />
      : <Advanced account={development} scriptVersion={12} onClose={() => {}} />}
  </BusyContext.Provider>);
  const label = { setup: "Install it", reinstall: "Reinstall", settings: "Save", account: "Sign out" }[kind];
  fireEvent.click(await screen.findByRole("button", { name: label }));
  expect(commands).not.toContain(kind === "settings" ? "save_settings" : kind === "account" ? "account_sign_out" : "install_connector");
});

it.each(["feedback", "delete"] as const)("refuses restart while a shared-turn %s mutation is pending", async (kind) => {
  const pending = deferred();
  vi.mocked(invoke).mockImplementation(async (cmd) => cmd === "install_update" ? undefined : pending.promise);
  const busy = createBusyState();
  render(<BusyContext.Provider value={busy}><FeedbackPanel turnId="turn" answered sharingEnabled sentCount={1} onSave={() => {}} /></BusyContext.Provider>);
  fireEvent.click(screen.getByRole("button", { name: "Tried this advice?" }));
  if (kind === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete shared turn…" }));
  fireEvent.click(screen.getByRole("button", { name: kind === "feedback" ? "Save outcome" : "Delete shared turn" }));
  await expect(installWhenIdle(busy)).rejects.toThrow("Finish");
  expect(invoke).not.toHaveBeenCalledWith("install_update");
  pending.resolve({ saved: true });
  await waitFor(() => expect(busy.accountMutation).toBe(false));
});

it("keeps the question flag through the actual delayed model command and rejects unknown Wire versions", async () => {
  const pending = deferred();
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    commands.push(cmd);
    if (cmd === "load_thread") return { goal: "", exchanges: [], note: [], next_bullet: 0, saved_at: 0 };
    if (cmd === "model_complete") return pending.promise;
  });
  Element.prototype.scrollIntoView = () => {};
  const busy = createBusyState();
  const state = { ...emptySet(), setId: "fixture", scriptVersion: null as number | null };
  const renderConversation = () => <BusyContext.Provider value={busy}><Conversation state={state} connected account={development} onTurnRunningChange={() => {}} onAnswer={() => {}} /></BusyContext.Provider>;
  const mounted = render(renderConversation());
  const input = await screen.findByRole("textbox", { name: "Ask about the set" }, { timeout: 2500 });
  expect((input as HTMLInputElement).disabled).toBe(true);
  state.scriptVersion = wireVersion.version - 1;
  mounted.rerender(renderConversation());
  expect((input as HTMLInputElement).disabled).toBe(true);
  state.scriptVersion = wireVersion.version;
  mounted.rerender(renderConversation());
  fireEvent.change(input, { target: { value: "What is selected?" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(commands).toContain("model_complete"));
  await expect(installWhenIdle(busy)).rejects.toThrow("Finish");
  pending.resolve({ text: "Fixture answer", tool_calls: [] });
  await waitFor(() => expect(busy.turn).toBe(false));
  expect(commands).not.toContain("install_update");
  await installWhenIdle(busy);
  expect(commands).toContain("install_update");
});
