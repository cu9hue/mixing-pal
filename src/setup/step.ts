export type SetupStep =
  | "install"
  | "open_live"
  | "control_surface"
  | "connected"
  | "account"
  | "goal"
  | "done";

/**
 * Everything the step depends on, all of it observable right now.
 *
 * `connectedAcknowledged` is the one piece of session state: the connected
 * screen is something she reads and moves past, and nothing observable
 * records that she has. It resets on relaunch, and on its own that would
 * put a machine set up months ago back on the connected screen -- the gate
 * order asks about it before `goalAnswered`, so having named a goal does
 * not save her. What saves her is `needsSetup` below:
 * whether setup opens at all is a separate question from which step it
 * shows once it is open.
 */
export interface SetupFacts {
  connectorInstalled: boolean;
  connectorCurrent: boolean;
  liveRunning: boolean;
  deltasArriving: boolean;
  connectedAcknowledged: boolean;
  hasAccount: boolean;
  goalAnswered: boolean;
}

/**
 * Which step to show, derived fresh every time.
 *
 * Nothing here is stored. A stored step index is wrong the moment she
 * uninstalls the connector, moves her User Library, or opens the app on a
 * machine where setup was already done -- and each of those leaves her
 * looking at a finished setup for an app that does not work.
 *
 * The order is a sequence of gates: each one must be satisfied before the
 * next is even asked about. That is what stops a logged-in account making
 * a disconnected app look ready.
 */
export function currentStep(facts: SetupFacts): SetupStep {
  // Sign-in comes first because it does not depend on Live.
  if (!facts.hasAccount) return "account";

  if (!facts.connectorInstalled || !facts.connectorCurrent) return "install";

  // Deltas are the only real evidence that the whole chain works. A
  // process check that fails on some machine must never strand someone
  // whose setup is fine, so it is only consulted when nothing is arriving.
  if (!facts.deltasArriving) {
    return facts.liveRunning ? "control_surface" : "open_live";
  }

  if (!facts.connectedAcknowledged) return "connected";
  if (!facts.goalAnswered) return "goal";
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
 * Deliberately narrower than `currentStep`. Setup used to open whenever
 * `currentStep` was not "done", which conflated "first run is incomplete"
 * with "we are not hearing from Live right now" -- so quitting Live, or
 * five seconds of lost traffic, threw the 600x680 setup window on top of
 * her work and re-centred it, and every launch reopened setup because
 * `connectedAcknowledged` starts false. It also made the `not_connected`
 * banner and the pill's disconnected state unreachable: the staleness that
 * should show them forced setup mode instead.
 *
 * Disconnection is a card-level state, not a first-run state. Only three
 * things reopen setup: the connector is missing, the connector is too old
 * to talk to this app, or she never finished setup.
 */
export function needsSetup(need: SetupNeed): boolean {
  // Guessing "not installed" before connector_status answers would flash
  // the setup window at someone whose setup has been done for months.
  if (need.connectorInstalled === null) return false;
  return !need.connectorInstalled || !need.connectorCurrent || !need.setupDone;
}
