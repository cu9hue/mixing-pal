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
 * records that she has. It resets on relaunch, which is correct -- a
 * finished setup never reaches that step again because `goalAnswered` and
 * `hasAccount` are already true.
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
  if (!facts.connectorInstalled || !facts.connectorCurrent) return "install";

  // Deltas are the only real evidence that the whole chain works. A
  // process check that fails on some machine must never strand someone
  // whose setup is fine, so it is only consulted when nothing is arriving.
  if (!facts.deltasArriving) {
    return facts.liveRunning ? "control_surface" : "open_live";
  }

  if (!facts.connectedAcknowledged) return "connected";
  if (!facts.hasAccount) return "account";
  if (!facts.goalAnswered) return "goal";
  return "done";
}
