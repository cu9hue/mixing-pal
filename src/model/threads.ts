import { invoke } from "@tauri-apps/api/core";
import { Bullet, Note } from "../notes/note";
import { Exchange } from "../ui/thread";
import { ThreadKey } from "../ui/threadStore";

/** What Rust saved for a set: see src-tauri/src/threads.rs. */
export interface SavedThread {
  exchanges: Exchange[];
  /** null awaits the goal prompt; empty means started without a goal. */
  goal: string | null;
  /** Seconds since the epoch. */
  saved_at: number;
  note: Bullet[];
  next_bullet: number;
}

export function loadThread(key: ThreadKey): Promise<SavedThread | null> {
  return invoke<SavedThread | null>("load_thread", { setId: key.id, setPath: key.path });
}

let writesLocked = false;
const pending = new Set<Promise<void>>();
const retry = new Map<string, () => Promise<void>>();
export function lockThreadSaves(locked: boolean): void { writesLocked = locked; }
export async function flushThreadSaves(): Promise<void> {
  await Promise.all([...pending]);
  for (const write of [...retry.values()]) await write();
}

export function saveThread(key: ThreadKey, exchanges: Exchange[], note: Note, goal: string | null): Promise<void> {
  if (writesLocked) return Promise.reject(new Error("Mixing Pal is preparing to restart."));
  const id = JSON.stringify(key);
  const write = (): Promise<void> => {
    const request = invoke<void>("save_thread", {
      setId: key.id,
      setPath: key.path,
      exchanges,
      goal,
      note: note.bullets,
      nextBullet: note.next,
    });
    pending.add(request);
    retry.set(id, write);
    void request.then(() => {
      pending.delete(request);
      if (retry.get(id) === write) retry.delete(id);
    }, () => { pending.delete(request); });
    return request;
  };
  return write();
}
