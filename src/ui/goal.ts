/**
 * The producer's stated goal -- "dark garage, 2am". The spec calls this
 * "probably the highest leverage" thing in the design, because it is what
 * makes an answer about her track rather than about music in general.
 *
 * It must survive a webview reload, not just a re-render.
 */
export const GOAL_STORAGE_KEY = "copilot.goal";

export const GOAL_MAX_LENGTH = 500;

/**
 * Reads the persisted goal.
 *
 * localStorage access can throw -- a SecurityError in some webview storage
 * configurations. This is called inside a useState initializer during
 * render, where an uncaught throw unmounts the whole pane rather than
 * losing one string. Do not remove the catch as unnecessary defensiveness.
 */
export function loadGoal(): string {
  try {
    return localStorage.getItem(GOAL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/**
 * Best-effort. Called from an input handler on every keystroke: losing
 * persistence is an acceptable degradation, letting a throw out of the
 * handler and breaking typing in the field is not.
 */
export function saveGoal(value: string): void {
  try {
    localStorage.setItem(GOAL_STORAGE_KEY, value);
  } catch {
    // See above.
  }
}
