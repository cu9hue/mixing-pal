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

export function saveThread(key: ThreadKey, exchanges: Exchange[], note: Note, goal: string | null): Promise<void> {
  return invoke("save_thread", {
    setId: key.id,
    setPath: key.path,
    exchanges,
    goal,
    note: note.bullets,
    nextBullet: note.next,
  });
}
