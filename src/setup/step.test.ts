import { describe, it, expect } from "vitest";
import { currentStep, SetupFacts } from "./step";

const DONE: SetupFacts = {
  connectorInstalled: true,
  connectorCurrent: true,
  liveRunning: true,
  deltasArriving: true,
  connectedAcknowledged: true,
  hasAccount: true,
  goalAnswered: true,
};

describe("currentStep", () => {
  it("finishes when every fact is satisfied", () => {
    expect(currentStep(DONE)).toBe("done");
  });

  it("starts at install on a clean machine", () => {
    expect(
      currentStep({
        connectorInstalled: false,
        connectorCurrent: false,
        liveRunning: false,
        deltasArriving: false,
        connectedAcknowledged: false,
        hasAccount: false,
        goalAnswered: false,
      }),
    ).toBe("install");
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

  it("shows the connected screen until she moves past it", () => {
    expect(currentStep({ ...DONE, connectedAcknowledged: false })).toBe("connected");
  });

  it("asks for an account after she has seen it work", () => {
    expect(currentStep({ ...DONE, hasAccount: false })).toBe("account");
  });

  it("asks what she is making last", () => {
    expect(currentStep({ ...DONE, goalAnswered: false })).toBe("goal");
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
});
