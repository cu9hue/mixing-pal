import { describe, it, expect } from "vitest";
import { offer, dismiss, EMPTY_NUDGE_STATE, COOLDOWN_MS } from "./nudges";

const NUDGE = { id: "unnamed_tracks", text: "Six tracks are still named MIDI or Audio." };
const T0 = 1_000_000;

describe("offer", () => {
  it("shows a nudge when nothing has fired before", () => {
    const next = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(next.current).toEqual(NUDGE);
    expect(next.lastFiredAt).toBe(T0);
  });

  it("holds the nudge while it is still on screen", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(offer(shown, NUDGE, T0 + 1000).current).toEqual(NUDGE);
  });

  it("refuses a new nudge inside the cooldown", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(dismissed, other, T0 + COOLDOWN_MS - 1).current).toBeNull();
  });

  it("allows a new nudge once the cooldown has passed", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(dismissed, other, T0 + COOLDOWN_MS).current).toEqual(other);
  });

  // Otherwise the same true observation reappears every two seconds for the
  // rest of the session, which is how a helpful nudge becomes an enemy.
  it("never re-raises a nudge she dismissed, however long it has been", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    expect(offer(dismissed, NUDGE, T0 + COOLDOWN_MS * 10).current).toBeNull();
  });

  it("clears the slot when the condition stops holding", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(offer(shown, null, T0 + 1000).current).toBeNull();
  });

  it("does not start the cooldown when there was nothing to show", () => {
    expect(offer(EMPTY_NUDGE_STATE, null, T0).lastFiredAt).toBeNull();
  });

  it("holds one nudge at a time", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(shown, other, T0 + COOLDOWN_MS * 2).current).toEqual(NUDGE);
  });

  it("keeps a ten-minute cooldown", () => {
    expect(COOLDOWN_MS).toBe(10 * 60 * 1000);
  });
});

describe("dismiss", () => {
  it("clears the slot and remembers the id", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const next = dismiss(shown, NUDGE.id);
    expect(next.current).toBeNull();
    expect(next.dismissed).toContain(NUDGE.id);
  });

  it("does not accumulate duplicates", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const twice = dismiss(dismiss(shown, NUDGE.id), NUDGE.id);
    expect(twice.dismissed).toEqual([NUDGE.id]);
  });
});
