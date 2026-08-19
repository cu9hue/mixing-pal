import { describe, it, expect } from "vitest";
import { pillState } from "./pillState";

const CONNECTED = { connected: true, unread: false, turnRunning: false };

describe("pillState", () => {
  it("is idle when connected with nothing happening", () => {
    expect(pillState(CONNECTED)).toBe("idle");
  });

  it("shows unread when something is waiting", () => {
    expect(pillState({ ...CONNECTED, unread: true })).toBe("unread");
  });

  it("shows thinking while a turn is running", () => {
    expect(pillState({ ...CONNECTED, turnRunning: true })).toBe("thinking");
  });

  it("prefers thinking over unread", () => {
    expect(pillState({ ...CONNECTED, turnRunning: true, unread: true })).toBe("thinking");
  });

  it("disconnected beats everything else", () => {
    expect(
      pillState({ connected: false, unread: true, turnRunning: true }),
    ).toBe("disconnected");
  });

  it("is disconnected when connected is false and nothing else is true", () => {
    expect(pillState({ connected: false, unread: false, turnRunning: false })).toBe(
      "disconnected",
    );
  });
});
