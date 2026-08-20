import { describe, it, expect } from "vitest";
import { nextMode, MODE_GEOMETRY, ModeContext } from "./windowMode";

const QUIET: ModeContext = { inputEmpty: true, turnRunning: false, unread: false };

describe("nextMode", () => {
  it("opens the card when the pill is clicked", () => {
    expect(nextMode("pill", { type: "pill_clicked" }, QUIET)).toBe("card");
  });

  it("opens the card when a nudge arrives", () => {
    expect(nextMode("pill", { type: "nudge_arrived" }, QUIET)).toBe("card");
  });

  it("opens the card when an answer completes", () => {
    expect(nextMode("pill", { type: "answer_completed" }, QUIET)).toBe("card");
  });

  it("collapses to the pill on escape", () => {
    expect(nextMode("card", { type: "escape" }, QUIET)).toBe("pill");
  });

  it("collapses to the pill when the chevron is closed", () => {
    expect(nextMode("card", { type: "chevron_closed" }, QUIET)).toBe("pill");
  });

  it("collapses on blur when nothing is in flight", () => {
    expect(nextMode("card", { type: "blur" }, QUIET)).toBe("pill");
  });

  it("stays open on blur when she has typed something", () => {
    expect(
      nextMode("card", { type: "blur" }, { ...QUIET, inputEmpty: false }),
    ).toBe("card");
  });

  it("stays open on blur while a turn is running", () => {
    expect(
      nextMode("card", { type: "blur" }, { ...QUIET, turnRunning: true }),
    ).toBe("card");
  });

  it("stays open on blur while something is unread", () => {
    expect(nextMode("card", { type: "blur" }, { ...QUIET, unread: true })).toBe("card");
  });

  it("setup keeps the window until it finishes, whatever else happens", () => {
    expect(nextMode("setup", { type: "nudge_arrived" }, QUIET)).toBe("setup");
    expect(nextMode("setup", { type: "pill_clicked" }, QUIET)).toBe("setup");
    expect(nextMode("setup", { type: "escape" }, QUIET)).toBe("setup");
  });

  it("setup hands off to the card when it finishes", () => {
    expect(nextMode("setup", { type: "setup_finished" }, QUIET)).toBe("card");
  });

  it("never re-enters setup once it is done", () => {
    expect(nextMode("card", { type: "setup_finished" }, QUIET)).toBe("card");
    expect(nextMode("pill", { type: "setup_finished" }, QUIET)).toBe("pill");
  });

  it("blur on the pill changes nothing", () => {
    expect(nextMode("pill", { type: "blur" }, QUIET)).toBe("pill");
  });
});

describe("MODE_GEOMETRY", () => {
  it("gives the card a content-following height with a ceiling", () => {
    expect(MODE_GEOMETRY.card.height).toBeNull();
    expect(MODE_GEOMETRY.card.maxHeight).toBe(520);
    expect(MODE_GEOMETRY.card.width).toBe(320);
  });

  it("keeps setup off the top of every other window", () => {
    expect(MODE_GEOMETRY.setup.alwaysOnTop).toBe(false);
    expect(MODE_GEOMETRY.setup.centered).toBe(true);
  });

  it("floats the pill and the card", () => {
    expect(MODE_GEOMETRY.pill.alwaysOnTop).toBe(true);
    expect(MODE_GEOMETRY.card.alwaysOnTop).toBe(true);
  });
});
