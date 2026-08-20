/**
 * Whether this person has finished first-run setup.
 *
 * The spec says setup state is derived, never stored, and that rule is
 * right about the *step index*: a stored cursor goes stale the moment she
 * uninstalls the connector or moves her User Library. This flag is not a
 * cursor. "She completed setup" is a fact about the world that cannot go
 * stale -- and nothing else observable records it, because Skip leaves the
 * goal empty, so a skipper who relaunched would be asked what she is
 * making every single time.
 *
 * Same try/catch treatment as ui/goal.ts: localStorage can throw in some
 * webview storage configurations, and losing this flag must degrade into
 * "show setup once more", never into an unmounted app.
 */
export const SETUP_DONE_KEY = "copilot.setupDone";

export function loadSetupDone(): boolean {
  try {
    return localStorage.getItem(SETUP_DONE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveSetupDone(done: boolean): void {
  try {
    localStorage.setItem(SETUP_DONE_KEY, done ? "1" : "0");
  } catch {
    // Best-effort only -- see above.
  }
}
