/** Persist completion only; steps are derived from current app conditions. */
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
    // Storage failure only causes setup to appear again.
  }
}
