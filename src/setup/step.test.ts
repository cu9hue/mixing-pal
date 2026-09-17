import { describe, it, expect } from "vitest";
import { currentStep, needsSetup, SetupFacts } from "./step";

const DONE: SetupFacts = {
  connectorInstalled: true,
  connectorCurrent: true,
  liveRunning: true,
  deltasArriving: true,
  connectedAcknowledged: true,
  hasAccount: true,
};

describe("currentStep", () => {
  it("finishes after the Live connection is acknowledged", () => {
    expect(currentStep(DONE)).toBe("done");
  });

  it("asks a new user to sign in before setting up Live", () => {
    expect(
      currentStep({
        connectorInstalled: false,
        connectorCurrent: false,
        liveRunning: false,
        deltasArriving: false,
        connectedAcknowledged: false,
        hasAccount: false,
      }),
    ).toBe("account");
  });

  // The app updated and the part inside Live did not. Reinstalling is the
  // fix, so it is the same step, not a special case.
  it("returns to install when the connector is out of date", () => {
    expect(currentStep({ ...DONE, connectorCurrent: false })).toBe("install");
  });

  it("asks her to open Live when it is not running", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, deltasArriving: false, connectedAcknowledged: false }),
    ).toBe("open_live");
  });

  it("asks her to select the Control Surface when Live is up but silent", () => {
    expect(
      currentStep({ ...DONE, deltasArriving: false, connectedAcknowledged: false }),
    ).toBe("control_surface");
  });

  // Deltas are the only real evidence. If they are arriving, whether we
  // managed to spot the Live process is irrelevant -- and a process check
  // that fails on some machine must never strand someone whose setup works.
  it("trusts arriving deltas over a failed process check", () => {
    expect(
      currentStep({ ...DONE, liveRunning: false, connectedAcknowledged: false }),
    ).toBe("connected");
  });

  // This is the right step to show *while setup is open*, and it used to be
  // read as a reason to open setup at all: `connectedAcknowledged` starts
  // false on every launch, so a machine set up months ago reopened the
  // setup window every time. Whether setup opens is needsSetup's question,
  // not this one -- see the regressions below.
  it("shows the connected screen while setup is open and she has not moved past it", () => {
    expect(currentStep({ ...DONE, connectedAcknowledged: false })).toBe("connected");
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
      currentStep({ ...DONE, connectedAcknowledged: false, hasAccount: false }),
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

  // The two regressions this function exists for. Both used to reopen the
  // 600x680 setup window on top of her work.
  it("does not reopen setup just because the connected screen was never acknowledged", () => {
    // connectedAcknowledged resets on every launch; it is not an input here.
    expect(needsSetup(READY)).toBe(false);
  });

  it("does not reopen setup when Live goes quiet", () => {
    // Quitting Live, or five seconds of lost traffic, is a card-level
    // state: the not_connected banner and the pill's disconnected state.
    // deltasArriving is not an input here either.
    expect(needsSetup(READY)).toBe(false);
    expect(currentStep({ ...DONE, deltasArriving: false })).toBe("control_surface");
  });
});
