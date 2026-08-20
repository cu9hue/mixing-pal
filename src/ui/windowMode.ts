/** The three shapes the single Tauri window takes. */
export type WindowMode = "setup" | "pill" | "card";

/**
 * Per-mode geometry that can actually change at runtime.
 *
 * Transparency and decorations are deliberately NOT here. Both are
 * window-creation flags in Tauri and cannot be changed once the window
 * exists, so the window is created transparent and undecorated once, and
 * every mode paints its own background in CSS. Putting them here would
 * describe a capability we do not have.
 */
export interface Geometry {
  width: number;
  /** null means "follow the content", bounded by maxHeight. */
  height: number | null;
  maxHeight: number | null;
  alwaysOnTop: boolean;
  centered: boolean;
}

/**
 * The card's ceiling, in pixels.
 *
 * Exported because CSS needs the same number: `.card` reads it as the
 * `--card-max-height` custom property that App publishes at startup. It
 * used to be `100vh` in Card.css, which made the measurement a fixed
 * point -- the viewport clamped the card before App could measure it, so
 * the window could only ever shrink, and never grew back out of the pill.
 */
export const CARD_MAX_HEIGHT = 520;

export const MODE_GEOMETRY: Record<WindowMode, Geometry> = {
  // Live's preferences cannot be taught in a 320px card, so setup is a
  // real window. Not on top: it is a task she completes, not a companion.
  setup: { width: 600, height: 680, maxHeight: null, alwaysOnTop: false, centered: true },
  // 44 square so the 26px dot has room for its glow.
  pill: { width: 44, height: 44, maxHeight: null, alwaysOnTop: true, centered: false },
  card: { width: 320, height: null, maxHeight: CARD_MAX_HEIGHT, alwaysOnTop: true, centered: false },
};

export type ModeEvent =
  | { type: "pill_clicked" }
  | { type: "nudge_arrived" }
  | { type: "answer_completed" }
  | { type: "escape" }
  | { type: "chevron_closed" }
  | { type: "blur" }
  | { type: "setup_finished" };

/**
 * Everything the collapse decision depends on, passed in rather than read
 * from module state so the machine stays pure.
 */
export interface ModeContext {
  inputEmpty: boolean;
  turnRunning: boolean;
  unread: boolean;
}

export function nextMode(mode: WindowMode, event: ModeEvent, ctx: ModeContext): WindowMode {
  // Setup owns the window until it finishes. A nudge or a completed answer
  // arriving mid-setup must not yank the window out from under her -- she
  // is in the middle of Live's preferences with a screenshot in front of
  // her, and losing it means starting the step again.
  if (mode === "setup") {
    return event.type === "setup_finished" ? "card" : "setup";
  }

  switch (event.type) {
    // Setup is entered by the app deciding a step is unsatisfied, never by
    // an event, so a stray finish signal changes nothing.
    case "setup_finished":
      return mode;
    case "pill_clicked":
    case "nudge_arrived":
    case "answer_completed":
      return "card";
    case "escape":
    case "chevron_closed":
      return "pill";
    case "blur":
      if (mode !== "card") return mode;
      // Collapsing a card she was halfway through typing into is worse
      // than leaving one open that she has finished with.
      return ctx.inputEmpty && !ctx.turnRunning && !ctx.unread ? "pill" : "card";
  }
}
