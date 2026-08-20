export interface Nudge {
  id: string;
  text: string;
}

/**
 * From the original design: "Global cooldown of 10 minutes. Per-rule
 * disable, not only a global mute. Every nudge is dismissible."
 */
export const COOLDOWN_MS = 10 * 60 * 1000;

export interface NudgeState {
  current: Nudge | null;
  /** When a nudge was last raised. null means none ever has been. */
  lastFiredAt: number | null;
  /** Ids she has dismissed this session. Never re-raised. */
  dismissed: string[];
}

export const EMPTY_NUDGE_STATE: NudgeState = {
  current: null,
  lastFiredAt: null,
  dismissed: [],
};

/**
 * Folds a rule's current verdict into the nudge slot.
 *
 * Called on every state change, so `candidate` is the same object over and
 * over while a condition holds. Everything here exists to stop that
 * becoming a nudge that reappears every two seconds -- which is how a true
 * and helpful observation turns into an enemy.
 */
export function offer(state: NudgeState, candidate: Nudge | null, now: number): NudgeState {
  // The condition stopped holding. Clear the slot but keep the cooldown:
  // a rule that flickers should not get to fire again immediately.
  if (candidate === null) {
    return state.current === null ? state : { ...state, current: null };
  }

  // Already on screen. Re-offering it must not restart its cooldown.
  if (state.current !== null) return state;

  if (state.dismissed.includes(candidate.id)) return state;

  if (state.lastFiredAt !== null && now - state.lastFiredAt < COOLDOWN_MS) return state;

  return { ...state, current: candidate, lastFiredAt: now };
}

export function dismiss(state: NudgeState, id: string): NudgeState {
  return {
    current: null,
    lastFiredAt: state.lastFiredAt,
    dismissed: state.dismissed.includes(id) ? state.dismissed : [...state.dismissed, id],
  };
}
