import { describe, it, expect } from "vitest";
import { currentStep, needsSetup, SetupFacts } from "./step";

const DONE: SetupFacts = {
  connectorInstalled: true,
  connectorCurrent: true,
  liveRunning: true,
  deltasArriving: true,
  hasAccount: true,
  sharingChosen: true,
  experienceChosen: true,
};

describe("currentStep", () => {
  it("finishes after the Live connection is acknowledged", () => {
    expect(currentStep(DONE)).toBe("done");
  });

  // The connected screen asks how she works; the choice is what finishes setup.
  it("shows the connected screen until she picks a level, then finishes", () => {
    expect(currentStep({ ...DONE, experienceChosen: false })).toBe("connected");
    expect(currentStep(DONE)).toBe("done");
  });

  // Choosing in Settings while setup is open ends setup too: both read App's state.
  it("finishes once a level exists, wherever she chose it", () => {
    expect(currentStep({ ...DONE, experienceChosen: true })).toBe("done");
  });

  it("asks a new user to sign in before setting up Live", () => {
    expect(
      currentStep({
        connectorInstalled: false,
        connectorCurrent: false,
        liveRunning: false,
        deltasArriving: false,
        hasAccount: false,
        sharingChosen: false,
        experienceChosen: false,
      }),
    ).toBe("account");
  });

  // Right after sign-in, before Live, so the question is never skipped by a
  // connector that is already installed.
  it("asks about sharing once signed in and before setting up Live", () => {
    expect(currentStep({ ...DONE, sharingChosen: false })).toBe("sharing");
    expect(
      currentStep({ ...DONE, sharingChosen: false, connectorInstalled: false, deltasArriving: false }),
    ).toBe("sharing");
    expect(currentStep({ ...DONE, sharingChosen: false, hasAccount: false })).toBe("account");
  });

  // The app updated and the part inside Live did not. Reinstalling is the
  // fix, so it is the same step, not a special case.
  it("returns to install when the connector is out of date", () => {
    expect(currentStep({ ...DONE, connectorCurrent: false })).toBe("install");
  });

  it("asks her to open Live when it is not running", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, deltasArriving: false }),
    ).toBe("open_live");
  });

  it("asks her to select the Control Surface when Live is up but silent", () => {
    expect(
      currentStep({ ...DONE, deltasArriving: false }),
    ).toBe("control_surface");
  });

  // Deltas are the only real evidence. If they are arriving, whether we
  // managed to spot the Live process is irrelevant -- and a process check
  // that fails on some machine must never strand someone whose setup works.
  it("trusts arriving deltas over a failed process check", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, experienceChosen: false }),
    ).toBe("connected");
  });

  // Whether setup opens is needsSetup's question, not this one.
  it("shows the connected screen while setup is open and no level is chosen", () => {
    expect(currentStep({ ...DONE, experienceChosen: false })).toBe("connected");
    expect(
      needsSetup({ connectorInstalled: true, connectorCurrent: true, setupDone: true }),
    ).toBe(false);
  });

  it("asks for an account before Live setup", () => {
    expect(currentStep({ ...DONE, hasAccount: false })).toBe("account");
  });

  // The whole point of deriving rather than storing. She uninstalls the
  // connector months later; setup must reopen at install, not at done.
  it("reopens at install when a finished setup is later broken", () => {
    expect(currentStep({ ...DONE, connectorInstalled: false })).toBe("install");
  });

  // Nothing after the Live steps may pre-empt them. Being logged in does
  // not make a disconnected app usable.
  it("never skips the Live steps because the later ones are satisfied", () => {
    expect(
      currentStep({
        ...DONE,
        connectorInstalled: false,
        liveRunning: false,
        deltasArriving: false,
      }),
    ).toBe("install");
  });

  // Authentication is independent of Live, so it comes first.
  it("asks for an account before showing the connection confirmation", () => {
    expect(
      currentStep({ ...DONE, experienceChosen: false, hasAccount: false }),
    ).toBe("account");
  });

});

describe("needsSetup", () => {
  const READY = { connectorInstalled: true, connectorCurrent: true, setupDone: true };

  it("stays out of the way once setup is finished", () => {
    expect(needsSetup(READY)).toBe(false);
  });

  it("opens on a clean machine", () => {
    expect(needsSetup({ ...READY, connectorInstalled: false, setupDone: false })).toBe(true);
  });

  it("opens when she has never finished setup", () => {
    expect(needsSetup({ ...READY, setupDone: false })).toBe(true);
  });

  it("opens when the connector is too old to talk to this app", () => {
    expect(needsSetup({ ...READY, connectorCurrent: false })).toBe(true);
  });

  it("opens when the connector was uninstalled after setup finished", () => {
    expect(needsSetup({ ...READY, connectorInstalled: false })).toBe(true);
  });

  it("waits for connector_status rather than guessing", () => {
    // Guessing "not installed" would flash the setup window at someone
    // whose setup has been done for months.
    expect(needsSetup({ ...READY, connectorInstalled: null, setupDone: false })).toBe(false);
  });

  // Setup must never reopen the 600x680 window on top of her work.
  it("does not reopen setup when Live goes quiet", () => {
    // Quitting Live, or five seconds of lost traffic, is a card-level
    // state: the not_connected banner and the pill's disconnected state.
    // deltasArriving is not an input here either.
    expect(needsSetup(READY)).toBe(false);
    expect(currentStep({ ...DONE, deltasArriving: false })).toBe("control_surface");
  });
});

it("waits for Live after copying a repair, and finishes only after matching traffic arrives", () => {
  const repaired = { ...DONE, connectorCopied: true, connectorCurrent: false, deltasArriving: false };
  expect(currentStep(repaired)).toBe("open_live");
  expect(currentStep({ ...repaired, connectorCurrent: true })).toBe("open_live");
  expect(currentStep({ ...repaired, connectorCurrent: true, deltasArriving: true })).toBe("done");
});
