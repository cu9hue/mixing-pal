import { beforeEach, expect, it, vi } from "vitest";
import { createBusyState, installWhenIdle, beginMutation } from "./updates";
import { flushThreadSaves, saveThread, lockThreadSaves } from "./threads";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { wireReady } from "../setup/step";
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
beforeEach(() => { vi.mocked(invoke).mockReset(); lockThreadSaves(false); });
it.each(["turn", "wireInstall", "settingsSave", "accountMutation"] as const)("refuses installation during %s and requires a fresh request", async (flag) => {
  const busy = createBusyState(); busy[flag] = true;
  await expect(installWhenIdle(busy)).rejects.toThrow("Finish");
  expect(invoke).not.toHaveBeenCalled();
  busy[flag] = false;
  await installWhenIdle(busy);
  expect(invoke).toHaveBeenCalledWith("install_update");
});
it("flushes a delayed real thread save before installing and closes mutation admission synchronously", async () => {
  const pending = deferred(); vi.mocked(invoke).mockImplementation((name) => name === "save_thread" ? pending.promise : Promise.resolve());
  const saving = saveThread({ id: "set", path: "/set" }, [], { bullets: [], next: 0 }, [], "");
  const busy = createBusyState(); const installing = installWhenIdle(busy);
  expect(busy.install).toBe(true);
  expect(beginMutation(busy, "wireInstall")).toBe(false);
  expect(beginMutation(busy, "settingsSave")).toBe(false);
  expect(beginMutation(busy, "accountMutation")).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("install_update");
  await expect(saveThread({ id: "late", path: null }, [], { bullets: [], next: 0 }, [], "")).rejects.toThrow("preparing to restart");
  pending.resolve(); await saving; await installing;
  expect(invoke).toHaveBeenCalledWith("install_update");
});
it("retains failed thread saves and retries them before restarting", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  await expect(saveThread({ id: "failed", path: "" }, [], { bullets: [], next: 0 }, [], "")).rejects.toThrow("disk full");
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  const busy = createBusyState();
  await expect(installWhenIdle(busy)).rejects.toThrow("disk full");
  expect(busy.install).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith("install_update");
  vi.mocked(invoke).mockResolvedValue(undefined);
  await flushThreadSaves(); await installWhenIdle(busy);
  expect(invoke).toHaveBeenCalledWith("install_update");
});
it.each([[true, null, false], [true, 11, false], [true, 12, true], [false, 12, false]] as const)("requires a known matching connected Wire", (connected, actual, ready) => {
  expect(wireReady(connected, actual, 12)).toBe(ready);
});
