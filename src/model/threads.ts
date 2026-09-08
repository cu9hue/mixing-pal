import { invoke } from "@tauri-apps/api/core";
import { Exchange } from "../ui/thread";
import { ThreadKey } from "../ui/threadStore";

/** What Rust saved for a set: see src-tauri/src/threads.rs. */
export interface SavedThread {
  exchanges: Exchange[];
  /** Seconds since the epoch. */
  saved_at: number;
}

export function loadThread(key: ThreadKey): Promise<SavedThread | null> {
  return invoke<SavedThread | null>("load_thread", { setId: key.id, setPath: key.path });
}

export function saveThread(key: ThreadKey, exchanges: Exchange[]): Promise<void> {
  return invoke("save_thread", { setId: key.id, setPath: key.path, exchanges });
}
