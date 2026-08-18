import { describe, it, expect } from "vitest";
import { selectBanner, VERSION_GRACE_MS, STALE_MS } from "./Connection";

const BASE = {
  now: 1_000_000,
  connectionStatus: null as null,
  lastSeen: 1_000_000,
  scriptVersion: 2,
  requiredVersion: 2,
  trafficStartedAt: 1_000_000,
};

describe("selectBanner", () => {
  it("renders nothing when the version matches and traffic is fresh", () => {
    expect(selectBanner(BASE)).toEqual({ kind: "none" });
  });

  it("bind_failed pre-empts every other case, even a stale connection", () => {
    expect(
      selectBanner({
        ...BASE,
        connectionStatus: { status: "bind_failed", port: 11001, error: "in use" },
        lastSeen: null,
      }),
    ).toEqual({ kind: "bind_failed", port: 11001, error: "in use" });
  });

  it("reports not_connected when no delta has ever arrived", () => {
    expect(selectBanner({ ...BASE, lastSeen: null })).toEqual({ kind: "not_connected" });
  });

  it("reports not_connected once the gap since the last delta exceeds STALE_MS", () => {
    const stale = selectBanner({
      ...BASE,
      lastSeen: BASE.now - STALE_MS - 1,
    });
    expect(stale).toEqual({ kind: "not_connected" });

    const fresh = selectBanner({
      ...BASE,
      lastSeen: BASE.now - STALE_MS + 1,
    });
    expect(fresh).toEqual({ kind: "none" });
  });

  it("reports version_mismatch naming both numbers when they differ", () => {
    expect(selectBanner({ ...BASE, scriptVersion: 1 })).toEqual({
      kind: "version_mismatch",
      required: 2,
      actual: 1,
    });
  });

  it("withholds stale_script during the grace window right after connecting", () => {
    const justConnected = selectBanner({
      ...BASE,
      scriptVersion: null,
      trafficStartedAt: BASE.now - VERSION_GRACE_MS + 1,
    });
    expect(justConnected).toEqual({ kind: "none" });
  });

  it("reports stale_script once traffic has flowed past the grace window with no version reply", () => {
    const overdue = selectBanner({
      ...BASE,
      scriptVersion: null,
      trafficStartedAt: BASE.now - VERSION_GRACE_MS - 1,
    });
    expect(overdue).toEqual({ kind: "stale_script" });
  });

  it("never shows stale_script when nothing is arriving -- that's not_connected's case", () => {
    const noTraffic = selectBanner({
      ...BASE,
      scriptVersion: null,
      lastSeen: null,
      trafficStartedAt: null,
    });
    expect(noTraffic).toEqual({ kind: "not_connected" });
  });
});
