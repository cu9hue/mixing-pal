import { describe, it, expect, vi, afterEach } from "vitest";
import { loadGoal, saveGoal, GOAL_STORAGE_KEY } from "./goal";

function stubStorage(impl: Partial<Storage>) {
  vi.stubGlobal("localStorage", impl as Storage);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadGoal", () => {
  it("returns the stored goal", () => {
    stubStorage({ getItem: () => "dark garage, 2am" });
    expect(loadGoal()).toBe("dark garage, 2am");
  });

  it("returns empty on a first run with nothing stored", () => {
    stubStorage({ getItem: () => null });
    expect(loadGoal()).toBe("");
  });

  // This runs inside a useState initializer during render. An uncaught
  // throw there unmounts the whole pane rather than losing one string --
  // some webview storage configurations raise SecurityError on access.
  it("returns empty rather than throwing when storage is unavailable", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadGoal()).toBe("");
  });

  it("survives storage being absent entirely", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadGoal()).toBe("");
  });
});

describe("saveGoal", () => {
  it("writes under the documented key", () => {
    const setItem = vi.fn();
    stubStorage({ setItem });
    saveGoal("dark garage, 2am");
    expect(setItem).toHaveBeenCalledWith(GOAL_STORAGE_KEY, "dark garage, 2am");
  });

  // Called from an input handler on every keystroke. A throw here would
  // break typing in the field, which is far worse than losing persistence.
  it("swallows a failing write rather than breaking the keystroke", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveGoal("x")).not.toThrow();
  });
});
