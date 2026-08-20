import { describe, it, expect } from "vitest";
import { nextMode, geometryApply, MODE_GEOMETRY, ModeContext } from "./windowMode";

const QUIET: ModeContext = { inputEmpty: true, turnRunning: false, unread: false };

describe("nextMode", () => {
  it("opens the card when the pill is clicked", () => {
    expect(nextMode("pill", { type: "pill_clicked" }, QUIET)).toBe("card");
  });

  it("opens the card when a nudge arrives", () => {
    expect(nextMode("pill", { type: "nudge_arrived" }, QUIET)).toBe("card");
  });

  // Deliberately NOT "card". Forcing the card open here made the pill's
  // unread state unreachable -- the same batch that set `unread` flipped the
  // view to card, and the effect that clears it ran before Pill ever
  // rendered. It also reopened a window over Live that she had just closed.
  it("leaves a collapsed card collapsed when an answer completes", () => {
    expect(nextMode("pill", { type: "answer_completed" }, QUIET)).toBe("pill");
  });

  it("leaves an open card open when an answer completes", () => {
    expect(nextMode("card", { type: "answer_completed" }, QUIET)).toBe("card");
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

describe("geometryApply", () => {
  const CARD_MEASURED = { view: "card" as const, height: 400 };

  it("applies nothing before the first measurement", () => {
    expect(geometryApply("card", null, null)).toBeNull();
  });

  // The bug this exists to prevent: the measuring effect and the applying
  // effect ran in the same commit, so a mode change applied the OUTGOING
  // mode's height to the incoming mode's window -- setup→card sent
  // {320, 680} and only then {320, 400}. Two native resizes, one of them
  // visibly wrong, on every single transition.
  it("applies nothing while the measurement belongs to the mode we just left", () => {
    expect(geometryApply("pill", CARD_MEASURED, null)).toBeNull();
  });

  it("applies the measured height once the measurement catches up", () => {
    expect(geometryApply("card", CARD_MEASURED, null)).toEqual({
      width: 320,
      height: 400,
      alwaysOnTop: true,
      center: false,
    });
  });

  it("centres a centred mode the first time it is entered", () => {
    expect(geometryApply("setup", { view: "setup", height: 680 }, null)?.center).toBe(true);
  });

  // Centring is a one-shot. Re-centring on every apply put the setup window
  // back a second after she dragged it.
  it("does not re-centre a mode it is already in", () => {
    expect(geometryApply("setup", { view: "setup", height: 680 }, "setup")?.center).toBe(false);
  });

  it("never centres the card or the pill", () => {
    expect(geometryApply("card", CARD_MEASURED, null)?.center).toBe(false);
    expect(geometryApply("pill", { view: "pill", height: 44 }, null)?.center).toBe(false);
  });
});
