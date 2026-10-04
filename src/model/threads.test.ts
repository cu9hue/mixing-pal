import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { flushThreadSaves, lockThreadSaves, loadThread, saveThread } from "./threads";
import { ThreadKey } from "../ui/threadStore";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const note = { bullets: [], next: 0 };
const save = (key: ThreadKey, goal: string, rekeyFrom: ThreadKey | null = null) => saveThread(key, [], note, [], goal, rekeyFrom);
const original = { id: "set", path: "/old.als" };
const rekeys = [
  { id: "set", path: "/new.als" },
  { id: "adopted", path: "/old.als" },
];
beforeEach(() => { vi.mocked(invoke).mockReset(); lockThreadSaves(false); });
afterEach(async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await flushThreadSaves();
});

it.each(rekeys)("does not replay an old failed snapshot after saving $id at $path", async (key) => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  await expect(save(original, "old")).rejects.toThrow("disk full");
  await save(key, "new", original);
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(rekeys)("retries only the latest failed snapshot after rekey to $id at $path", async (key) => {
  vi.mocked(invoke).mockRejectedValue(new Error("disk full"));
  await expect(save(original, "old")).rejects.toThrow("disk full");
  await expect(save(key, "new", original)).rejects.toThrow("disk full");
  vi.mocked(invoke).mockClear().mockResolvedValue(undefined);
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: key.id, setPath: key.path, goal: "new" }));
});

it.each(rekeys)("does not restore a superseded retry when its pending save fails after $id at $path succeeds", async (key) => {
  let reject!: (error: Error) => void;
  vi.mocked(invoke).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  const old = expect(save(original, "old")).rejects.toThrow("disk full");
  await save(key, "new", original);
  reject(new Error("disk full"));
  await old;
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).not.toHaveBeenCalled();
});

it.each(rekeys)("keeps a newer pending save when the old save succeeds after rekey to $id at $path", async (key) => {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  vi.mocked(invoke)
    .mockReturnValueOnce(new Promise<void>((done) => { resolve = done; }))
    .mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail; }));
  const old = save(original, "old");
  const latest = expect(save(key, "new", original)).rejects.toThrow("disk full");
  resolve(); await old;
  reject(new Error("disk full")); await latest;
  vi.mocked(invoke).mockClear().mockResolvedValue(undefined);
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: key.id, goal: "new" }));
});

it.each([null, "", "/other.als"])("preserves an unrelated failed save with path %s", async (path) => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  await expect(save({ id: "other", path }, "keep")).rejects.toThrow("disk full");
  await save({ id: "set", path: path === "/other.als" ? "/set.als" : path }, "new");
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: "other", goal: "keep" }));
});

it("prefers an existing ID over another retry with the same path", async () => {
  vi.mocked(invoke).mockRejectedValue(new Error("disk full"));
  await expect(save(original, "old")).rejects.toThrow("disk full");
  await expect(save({ id: "other", path: "/other.als" }, "keep")).rejects.toThrow("disk full");
  vi.mocked(invoke).mockResolvedValue(undefined);
  await save({ id: "set", path: "/other.als" }, "new");
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: "other", goal: "keep" }));
});


it.each(["saved", "loaded", "unseen"])("preserves another ID's retry at the same path when the target ID is %s", async (known) => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  if (known === "saved") await save(original, "already saved");
  if (known === "loaded") {
    vi.mocked(invoke).mockResolvedValueOnce({ exchanges: [], goal: "loaded", saved_at: 0, note: [], next_bullet: 0, outcomes: [] });
    await loadThread(original);
  }
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full"));
  await expect(save({ id: "other", path: "/shared.als" }, "keep")).rejects.toThrow("disk full");
  await save({ id: "set", path: "/shared.als" }, "new");
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: "other", goal: "keep" }));
});

it("preserves the previous retry when an explicit rekey is refused by the restart lock", async () => {
  vi.mocked(invoke).mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined);
  await expect(save(original, "keep")).rejects.toThrow("disk full");
  lockThreadSaves(true);
  await expect(save(rekeys[1], "new", original)).rejects.toThrow("preparing to restart");
  vi.mocked(invoke).mockClear();
  await flushThreadSaves();
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke).toHaveBeenCalledWith("save_thread", expect.objectContaining({ setId: "set", goal: "keep" }));
});
