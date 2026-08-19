export type PillState = "idle" | "unread" | "thinking" | "disconnected";

export interface PillInput {
  connected: boolean;
  unread: boolean;
  turnRunning: boolean;
}

/**
 * Which of four appearances the collapsed pill wears. Order matters; the
 * cases are not mutually exclusive.
 *
 * Disconnected wins outright, for the same reason bind_failed pre-empts
 * every other banner in Connection.tsx: an unread answer she cannot follow
 * up on, or a turn that is about to fail, is not the thing she needs to
 * know. Thinking beats unread because an in-flight turn is the most recent
 * thing that happened, and completing it re-raises unread anyway.
 */
export function pillState({ connected, unread, turnRunning }: PillInput): PillState {
  if (!connected) return "disconnected";
  if (turnRunning) return "thinking";
  if (unread) return "unread";
  return "idle";
}
