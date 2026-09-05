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
  // Live's preferences cannot be taught in a 380px card, so setup is a
  // real window. Not on top: it is a task she completes, not a companion.
  setup: { width: 600, height: 680, maxHeight: null, alwaysOnTop: false, centered: true },
  // 52 square so the 34px body has room for its shadow and its unread
  // glow. The window is transparent, so any shadow that reaches past the
  // window edge is not softened there -- it is cut off square, painting a
  // dark rectangle around the pill. The margin here and the shadow radii
  // in Pill.css are one budget; widen either and check the other.
  pill: { width: 52, height: 52, maxHeight: null, alwaysOnTop: true, centered: false },
  // 380 so a three-column table gets about 110px a column; see Card.css.
  card: { width: 380, height: null, maxHeight: CARD_MAX_HEIGHT, alwaysOnTop: true, centered: false },
};

/** A height, and the mode it was measured for. The pairing is the point. */
export interface Measured {
  view: WindowMode;
  height: number;
}

/**
 * A type alias, not an interface, on purpose: Tauri's `invoke` takes a
 * `Record<string, unknown>`, and TypeScript grants an implicit index
 * signature to aliases but never to interfaces. As an interface this cannot
 * be passed to `invoke` without spreading it into a fresh literal, which is
 * exactly the kind of shapeless copy that lets a field go missing.
 */
export type GeometryApply = {
  width: number;
  height: number;
  alwaysOnTop: boolean;
  center: boolean;
};

/**
 * What to send to `set_window_mode`, or null when nothing should be sent yet.
 *
 * Measuring and applying happen in two different effects, and on a mode
 * change the applying one runs first -- with a height measured for the mode
 * we just left. Applying it sized the incoming window to the outgoing
 * content: setup→card sent {380, 680} and only then {380, 400}, so every
 * transition pushed one visibly wrong frame through a native resize the
 * compositor does not batch. Pairing the height with the mode it was
 * measured for turns that into a check this function can make.
 *
 * `centredFor` is the mode the window was last centred in. Centring is a
 * one-shot on entry: re-centring on every apply put the setup window back a
 * second after she dragged it.
 */
export function geometryApply(
  view: WindowMode,
  measured: Measured | null,
  centredFor: WindowMode | null,
): GeometryApply | null {
  if (measured === null || measured.view !== view) return null;
  const geometry = MODE_GEOMETRY[view];
  return {
    width: geometry.width,
    height: measured.height,
    alwaysOnTop: geometry.alwaysOnTop,
    center: geometry.centered && centredFor !== view,
  };
}

export type ModeEvent =
  | { type: "pill_clicked" }
  | { type: "escape" }
  | { type: "chevron_closed" }
  | { type: "setup_finished" };

/**
 * The card closes only when she closes it.
 *
 * A `blur` event used to collapse the card whenever the window lost focus,
 * gated on the input being empty with no turn running and nothing unread.
 * It defeated the thing the app is for: reading advice while working in
 * Live. Every click into Ableton took the answer off screen, which is the
 * one moment she needs it. Escape and the header chevron are the two ways
 * out, and both are hers.
 *
 * This is why there is no ModeContext. Nothing else in the machine reads
 * what she was typing or whether a turn is running -- that state existed
 * for the blur gate alone.
 */
export function nextMode(mode: WindowMode, event: ModeEvent): WindowMode {
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
    // The only event that opens the card. There were two others -- a
    // completed answer and an arriving nudge -- and both are gone. An answer
    // she is watching needs no transition; one that lands after she pressed
    // Escape must not reopen a window over Live; and a nudge is unprompted,
    // which makes taking the screen for it the most intrusive thing this app
    // can do. The pill's unread glow carries both instead, and it only has a
    // job if the card can stay shut.
    case "pill_clicked":
      return "card";
    case "escape":
    case "chevron_closed":
      return "pill";
  }
}
