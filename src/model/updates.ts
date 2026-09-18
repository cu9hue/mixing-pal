import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { flushThreadSaves, lockThreadSaves } from "./threads";

export interface BusyState {
  turn: boolean;
  wireInstall: boolean;
  settingsSave: boolean;
  accountMutation: boolean;
  install: boolean;
}
export const createBusyState = (): BusyState => ({ turn: false, wireInstall: false, settingsSave: false, accountMutation: false, install: false });
export const BusyContext = createContext<BusyState | null>(null);
export function useBusyState(): BusyState {
  const shared = useContext(BusyContext);
  const local = useRef(createBusyState());
  return shared ?? local.current;
}
export function beginMutation(busy: BusyState, flag: Exclude<keyof BusyState, "install">): boolean {
  if (busy.install || busy[flag]) return false;
  busy[flag] = true;
  return true;
}
export async function installWhenIdle(busy: BusyState): Promise<void> {
  if (Object.values(busy).some(Boolean)) throw new Error("Finish the current question or settings change before installing.");
  busy.install = true;
  lockThreadSaves(true);
  try {
    await flushThreadSaves();
    await invoke("install_update");
  } catch (error) {
    busy.install = false;
    lockThreadSaves(false);
    throw error;
  }
}
export type UpdateChannel = "stable" | "pilot";
export interface UpdateView {
  channel: UpdateChannel;
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  version?: string;
  notes?: string;
  message?: string;
}
export function useUpdates(busy: BusyState) {
  const [view, setView] = useState<UpdateView>({ channel: "stable", phase: "idle" });
  const [installing, setInstalling] = useState(false);
  const running = useRef(false);
  const action = useCallback(async (command: string, phase: UpdateView["phase"], args?: Record<string, unknown>) => {
    if (running.current || busy.install) return;
    running.current = true;
    setView((v) => ({ ...v, phase, message: undefined }));
    try { setView(await invoke<UpdateView>(command, args)); }
    catch (error) { setView((v) => ({ ...v, phase: "error", message: String(error) })); }
    finally { running.current = false; }
  }, [busy]);
  const check = useCallback(() => action("check_update", "checking"), [action]);
  useEffect(() => { void check(); }, [check]);
  async function install() {
    if (running.current || busy.install) return;
    setInstalling(true);
    try { await installWhenIdle(busy); }
    catch (error) { setView((v) => ({ ...v, message: String(error) })); setInstalling(false); }
  }
  async function channel(channel: UpdateChannel) {
    if (running.current || !beginMutation(busy, "settingsSave")) return;
    try { await action("set_update_channel", "checking", { channel }); }
    finally { busy.settingsSave = false; }
  }
  return { view, installing, check, download: () => action("download_update", "downloading"), install, channel };
}
export type Updates = ReturnType<typeof useUpdates>;
