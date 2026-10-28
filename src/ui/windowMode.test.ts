import { describe, it, expect } from "vitest";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { readFileSync } from "node:fs";
// @ts-expect-error no @types/node in this project; see vite.config.ts
import { fileURLToPath } from "node:url";
import { nextMode, geometryApply, MODE_GEOMETRY, ModeEvent } from "./windowMode";

/** Every event the machine accepts, so the tests below can be exhaustive. */
const EVERY_EVENT: ModeEvent[] = [
  { type: "pill_clicked" },
  { type: "escape" },
  { type: "chevron_closed" },
  { type: "setup_finished" },
  { type: "settings_opened" },
];

describe("nextMode", () => {
  it("opens the card when the pill is clicked", () => {
    expect(nextMode("pill", { type: "pill_clicked" })).toBe("card");
  });

  // The card opens on exactly one thing: the producer clicking the pill. Two events
  // used to open it on the app's own initiative -- a completed answer and an
  // arriving nudge -- and both were removed. An answer the producer is watching needs
  // no transition, one that lands after the producer pressed Escape must not reopen a
  // window over Live, and a nudge is unprompted, which makes taking the
  // screen for it the most intrusive thing this app could do. The pill's
  // unread glow carries both instead.
  it("opens the card on nothing but the producer's own click or Settings pick", () => {
    for (const event of EVERY_EVENT) {
      if (event.type === "pill_clicked" || event.type === "settings_opened") continue;
      expect(nextMode("pill", event)).toBe("pill");
    }
    expect(nextMode("pill", { type: "pill_clicked" })).toBe("card");
    expect(nextMode("pill", { type: "settings_opened" })).toBe("card");
  });

  it("collapses to the pill on escape", () => {
    expect(nextMode("card", { type: "escape" })).toBe("pill");
  });

  it("collapses to the pill when the chevron is closed", () => {
    expect(nextMode("card", { type: "chevron_closed" })).toBe("pill");
  });

  // The mirror of the test above, and the one that matters most in daily
  // use. The card used to collapse on `blur`, so every click into Ableton
  // took the answer off screen -- while the producer was working in Live, which is
  // the only time the answer is worth anything. Closing the card is the producer's
  // to do, and there are exactly two ways to do it.
  it("closes on nothing but escape or the chevron", () => {
    const closers = ["escape", "chevron_closed"];
    for (const event of EVERY_EVENT) {
      const expected = closers.includes(event.type) ? "pill" : "card";
      expect(nextMode("card", event)).toBe(expected);
    }
  });

  it("setup keeps the window until it finishes, whatever else happens", () => {
    expect(nextMode("setup", { type: "pill_clicked" })).toBe("setup");
    expect(nextMode("setup", { type: "escape" })).toBe("setup");
  });

  it("setup hands off to the card when it finishes", () => {
    expect(nextMode("setup", { type: "setup_finished" })).toBe("card");
  });

  it("never re-enters setup once it is done", () => {
    expect(nextMode("card", { type: "setup_finished" })).toBe("card");
    expect(nextMode("pill", { type: "setup_finished" })).toBe("pill");
  });
});

/**
 * A source-level tripwire, in the same spirit as cardStaysMounted.test.ts.
 *
 * The machine above can only refuse events it is given. Re-adding the
 * auto-collapse means adding a window listener in App and a case here, and
 * the exhaustive tests would happily grow to cover the new event. This is
 * the assertion that does not move: App subscribes to no focus-loss event
 * at all.
 */
describe("losing focus to Live", () => {
  const app = readFileSync(fileURLToPath(new URL("../App.tsx", import.meta.url)), "utf8");

  it("is not listened for", () => {
    expect(app).not.toMatch(/addEventListener\(\s*["'](blur|focusout)["']/);
  });
});

describe("MODE_GEOMETRY", () => {
  it("gives the card a content-following height with a ceiling", () => {
    expect(MODE_GEOMETRY.card.height).toBeNull();
    expect(MODE_GEOMETRY.card.maxHeight).toBe(520);
    expect(MODE_GEOMETRY.card.width).toBe(380);
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
  // {380, 680} and only then {380, 400}. Two native resizes, one of them
  // visibly wrong, on every single transition.
  it("applies nothing while the measurement belongs to the mode we just left", () => {
    expect(geometryApply("pill", CARD_MEASURED, null)).toBeNull();
  });

  it("applies the measured height once the measurement catches up", () => {
    expect(geometryApply("card", CARD_MEASURED, null)).toEqual({
      width: 380,
      height: 400,
      alwaysOnTop: true,
      center: false,
    });
  });

  it("centres a centred mode the first time it is entered", () => {
    expect(geometryApply("setup", { view: "setup", height: 680 }, null)?.center).toBe(true);
  });

  // Centring is a one-shot. Re-centring on every apply put the setup window
  // back a second after the producer dragged it.
  it("does not re-centre a mode it is already in", () => {
    expect(geometryApply("setup", { view: "setup", height: 680 }, "setup")?.center).toBe(false);
  });

  it("never centres the card or the pill", () => {
    expect(geometryApply("card", CARD_MEASURED, null)?.center).toBe(false);
    expect(geometryApply("pill", { view: "pill", height: 52 }, null)?.center).toBe(false);
  });
});
