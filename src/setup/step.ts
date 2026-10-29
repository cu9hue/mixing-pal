export type SetupStep =
  | "install"
  | "open_live"
  | "control_surface"
  | "connected"
  | "account"
  | "plan"
  | "sharing"
  | "done";

export interface SetupFacts {
  connectorInstalled: boolean;
  connectorCurrent: boolean;
  connectorCopied?: boolean;
  liveRunning: boolean;
  deltasArriving: boolean;
  /** Signed in, with or without a plan. */
  hasAccount: boolean;
  /** A plan, a trial, or pilot access. */
  hasAccess: boolean;
  /** Whether the producer answered the current sharing question, either way. */
  sharingChosen: boolean;
  /** False while Rust has not answered, so the question shows rather than
      setup finishing early. */
  experienceChosen: boolean;
}

/**
 * Which step to show, derived fresh every time.
 *
 * Nothing here is stored. A stored step index is wrong the moment the producer
 * uninstalls the connector, moves their User Library, or opens the app on a
 * machine where setup was already done -- and each of those leaves them
 * looking at a finished setup for an app that does not work.
 *
 * The order is a sequence of gates: each one must be satisfied before the
 * next is even asked about. That is what stops a logged-in account making
 * a disconnected app look ready.
 */
export function currentStep(facts: SetupFacts): SetupStep {
  // Sign-in comes first because it does not depend on Live.
  if (!facts.hasAccount) return "account";

  if (facts.connectorCopied && (!facts.connectorCurrent || !facts.deltasArriving)) return "open_live";
  if (!facts.connectorInstalled || !facts.connectorCurrent) return "install";

  // Deltas are the only real evidence that the whole chain works. A
  // process check that fails on some machine must never strand someone
  // whose setup is fine, so it is only consulted when nothing is arriving.
  if (!facts.deltasArriving) {
    return facts.liveRunning ? "control_surface" : "open_live";
  }

  // The connected screen asks how the producer works. A level, chosen there or in
  // Settings, moves the producer on.
  if (!facts.experienceChosen) return "connected";
  // The plan comes after the app has shown it can read the set. Sharing
  // comes after the plan: consent is stored on the member, and a member
  // exists only once there is access.
  if (!facts.hasAccess) return "plan";
  if (!facts.sharingChosen) return "sharing";
  return "done";
}

/** Everything the decision to open setup at all depends on. */
export interface SetupNeed {
  /** null while connector_status has not answered yet. */
  connectorInstalled: boolean | null;
  connectorCurrent: boolean;
  /** The persisted flag from setupDone.ts. */
  setupDone: boolean;
}

/**
 * Whether to show the setup window.
 *
 * Narrower than `currentStep`: a quiet Live (quit, or five seconds of lost
 * traffic) is a card-level state for the banner and the pill, not a reason to reopen setup.
 */
export function needsSetup(need: SetupNeed): boolean {
  // Guessing "not installed" before connector_status answers would flash
  // the setup window at someone whose setup has been done for months.
  if (need.connectorInstalled === null) return false;
  return !need.connectorInstalled || !need.connectorCurrent || !need.setupDone;
}

export function wireReady(connected: boolean, actual: number | null, expected: number): boolean {
  return connected && actual !== null && actual === expected;
}
