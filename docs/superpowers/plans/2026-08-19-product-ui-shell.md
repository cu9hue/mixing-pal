# Product UI: The Shell — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the test-harness UI with the designed product surface — a frameless always-on-top card that collapses to a pill, built on design tokens, with one nudge rule.

**Architecture:** One Tauri window in three modes, driven by a pure TypeScript mode machine and applied by a Rust `set_window_mode` command. All presentation moves from inline style objects to CSS custom properties in `src/ui/theme.css` plus colocated component CSS. Every non-trivial decision — which mode to be in, which pill state to show, what the progress line says, whether a nudge fires — lives in a pure function with its own test; components render those results and are not themselves tested.

**Tech Stack:** Tauri 2, React 19, TypeScript 5.8, Vite 7, vitest 4, plain CSS with custom properties. Rust with serde. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-19-product-ui-design.md`

## Global Constraints

- **No new dependencies, in either `package.json` or `Cargo.toml`.** Not Tailwind, not a CSS-in-JS library, not React Testing Library, not jsdom, not `tempfile`.
- **Tests are pure functions in `.test.ts` files run by vitest.** The repo has no component-testing setup and this plan does not add one. `src/ui/Connection.test.ts` is the pattern: import a pure function, feed it a struct, assert the result. If a behaviour is worth testing, extract it into a pure function first.
- **Rust tests use scratch directories built from `std::env::temp_dir()` plus an `AtomicUsize` counter.** `src-tauri/src/settings.rs`'s `scratch()` is the pattern.
- **`selectBanner` in `src/ui/Connection.tsx` and every test in `src/ui/Connection.test.ts` must not change.** The banner logic is correct and tested; only its rendering is replaced. A diff that touches either is wrong.
- **Product name in user-facing copy is `Mixing Pal`.** The rename sweep — `productName`, `identifier`, the `/live/copilot/*` OSC namespace, `remote-script/AbletonCopilot/`, `scripts/install-remote-script.sh` — belongs to the distribution plan. **Do not touch any of them.** Window title and visible copy only.
- **The disclaimer is permanent and non-dismissible**, verbatim: `AI can make mistakes. Treat responses as suggestions.`
- **The permanent chrome never shows tempo, key, or track count.** They appear only inside the "What I can see" disclosure. This is spec principle 1 and it is the reason the header holds three elements.
- **The accent colour `--accent` appears at most twice in any one rendered view.** A third use is decoration; remove it.
- **The window never steals focus.** No `set_focus`, no autofocus on mode change.
- Verification commands: `npm test` (frontend), `cd src-tauri && cargo test` (backend), `npm run build` (typecheck). Pipe output to a file and grep it, per the repo's testing convention.

---

### Task 1: The window-mode machine

Pure decision function for which of the three window modes the app should be in. Nothing renders yet; this is the logic every later task depends on.

**Files:**
- Create: `src/ui/windowMode.ts`
- Test: `src/ui/windowMode.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type WindowMode = "setup" | "pill" | "card"`; `interface Geometry`; `const MODE_GEOMETRY: Record<WindowMode, Geometry>`; `type ModeEvent`; `interface ModeContext`; `function nextMode(mode: WindowMode, event: ModeEvent, ctx: ModeContext): WindowMode`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/windowMode.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { nextMode, MODE_GEOMETRY, ModeContext } from "./windowMode";

const QUIET: ModeContext = { inputEmpty: true, turnRunning: false, unread: false };

describe("nextMode", () => {
  it("opens the card when the pill is clicked", () => {
    expect(nextMode("pill", { type: "pill_clicked" }, QUIET)).toBe("card");
  });

  it("opens the card when a nudge arrives", () => {
    expect(nextMode("pill", { type: "nudge_arrived" }, QUIET)).toBe("card");
  });

  it("opens the card when an answer completes", () => {
    expect(nextMode("pill", { type: "answer_completed" }, QUIET)).toBe("card");
  });

  it("collapses to the pill on escape", () => {
    expect(nextMode("card", { type: "escape" }, QUIET)).toBe("pill");
  });

  it("collapses to the pill when the chevron is closed", () => {
    expect(nextMode("card", { type: "chevron_closed" }, QUIET)).toBe("pill");
  });

  it("collapses on blur when nothing is in flight", () => {
    expect(nextMode("card", { type: "blur" }, QUIET)).toBe("pill");
  });

  it("stays open on blur when she has typed something", () => {
    expect(
      nextMode("card", { type: "blur" }, { ...QUIET, inputEmpty: false }),
    ).toBe("card");
  });

  it("stays open on blur while a turn is running", () => {
    expect(
      nextMode("card", { type: "blur" }, { ...QUIET, turnRunning: true }),
    ).toBe("card");
  });

  it("stays open on blur while something is unread", () => {
    expect(nextMode("card", { type: "blur" }, { ...QUIET, unread: true })).toBe("card");
  });

  it("setup keeps the window until it finishes, whatever else happens", () => {
    expect(nextMode("setup", { type: "nudge_arrived" }, QUIET)).toBe("setup");
    expect(nextMode("setup", { type: "pill_clicked" }, QUIET)).toBe("setup");
    expect(nextMode("setup", { type: "escape" }, QUIET)).toBe("setup");
  });

  it("setup hands off to the card when it finishes", () => {
    expect(nextMode("setup", { type: "setup_finished" }, QUIET)).toBe("card");
  });

  it("never re-enters setup once it is done", () => {
    expect(nextMode("card", { type: "setup_finished" }, QUIET)).toBe("card");
    expect(nextMode("pill", { type: "setup_finished" }, QUIET)).toBe("pill");
  });

  it("blur on the pill changes nothing", () => {
    expect(nextMode("pill", { type: "blur" }, QUIET)).toBe("pill");
  });
});

describe("MODE_GEOMETRY", () => {
  it("gives the card a content-following height with a ceiling", () => {
    expect(MODE_GEOMETRY.card.height).toBeNull();
    expect(MODE_GEOMETRY.card.maxHeight).toBe(520);
    expect(MODE_GEOMETRY.card.width).toBe(320);
  });

  it("keeps setup off the top of every other window", () => {
    expect(MODE_GEOMETRY.setup.alwaysOnTop).toBe(false);
    expect(MODE_GEOMETRY.setup.centered).toBe(true);
  });

  it("floats the pill and the card", () => {
    expect(MODE_GEOMETRY.pill.alwaysOnTop).toBe(true);
    expect(MODE_GEOMETRY.card.alwaysOnTop).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/windowMode.test.ts 2>&1 | tee /tmp/t1.log`
Expected: FAIL — `Failed to resolve import "./windowMode"`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/windowMode.ts`:

```ts
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

export const MODE_GEOMETRY: Record<WindowMode, Geometry> = {
  // Live's preferences cannot be taught in a 320px card, so setup is a
  // real window. Not on top: it is a task she completes, not a companion.
  setup: { width: 600, height: 680, maxHeight: null, alwaysOnTop: false, centered: true },
  // 44 square so the 26px dot has room for its glow.
  pill: { width: 44, height: 44, maxHeight: null, alwaysOnTop: true, centered: false },
  card: { width: 320, height: null, maxHeight: 520, alwaysOnTop: true, centered: false },
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/windowMode.test.ts 2>&1 | tee /tmp/t1.log`
Expected: PASS, 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/windowMode.ts src/ui/windowMode.test.ts
git commit -m "Add the window-mode machine

Pure decision function for setup/pill/card. Transparency and decorations
are deliberately absent from Geometry: both are window-creation flags in
Tauri, so the window is created transparent and undecorated once and each
mode paints its own background."
```

---

### Task 2: Design tokens, and a test that keeps them honest

The token file, plus a test that fails when any component references a custom property nobody defined. That test is cheap now and earns its keep across every later task.

**Files:**
- Create: `src/ui/theme.css`
- Create: `src/ui/theme.test.ts`
- Modify: `src/main.tsx`
- Modify: `index.html`
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: nothing.
- Produces: the CSS custom properties every later task's CSS uses, and `src/ui/theme.test.ts`'s guarantee that none of them is a typo.

- [ ] **Step 1: Write the failing test**

Create `src/ui/theme.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(__dirname, "..");

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return path.endsWith(".css") ? [path] : [];
  });
}

/** Every `--name` given a value anywhere under src/. */
function defined(): Set<string> {
  const names = new Set<string>();
  for (const file of cssFiles(SRC)) {
    for (const m of readFileSync(file, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Every `var(--name)` read anywhere under src/, with the file that reads it. */
function used(): Array<{ name: string; file: string }> {
  return cssFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => ({
      name: m[1],
      file,
    })),
  );
}

describe("design tokens", () => {
  // The whole point of moving off inline style objects was to get one
  // place where colour lives. A var(--typo) silently renders as nothing,
  // which looks like a layout bug and gets debugged as one.
  it("defines every custom property that any stylesheet reads", () => {
    const known = defined();
    const orphans = used().filter((u) => !known.has(u.name));
    expect(orphans).toEqual([]);
  });

  it("defines the palette the spec names", () => {
    const known = defined();
    for (const token of [
      "--surface",
      "--surface-raised",
      "--surface-sunken",
      "--border",
      "--border-strong",
      "--text",
      "--text-secondary",
      "--text-muted",
      "--text-faint",
      "--accent",
      "--ok",
      "--error",
      "--radius-card",
      "--radius-control",
      "--radius-pill",
      "--shadow-card",
    ]) {
      expect(known, `missing token ${token}`).toContain(token);
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/theme.test.ts 2>&1 | tee /tmp/t2.log`
Expected: FAIL — "defines the palette the spec names" fails because no `.css` file exists yet.

- [ ] **Step 3: Write the token file**

Create `src/ui/theme.css`:

```css
/*
 * The one place colour, radius, and type scale live.
 *
 * Direction is "Composed": the card is its own object sitting above Live,
 * not a panel that lost its window. That means a surface deeper than
 * Live's grey, one warm accent used sparingly, and soft depth.
 *
 * Every value here is from docs/superpowers/specs/2026-08-19-product-ui-design.md.
 * Change the spec first.
 */
:root {
  --surface: #151619;
  --surface-raised: #1b1d21;
  --surface-sunken: #101113;

  --border: rgba(255, 255, 255, 0.07);
  --border-strong: rgba(255, 255, 255, 0.12);

  /* Four steps, brightest to faintest. The model's prose is the brightest
     thing in the app; everything the app measured is dimmer than it. */
  --text: #e8e9ec;
  --text-secondary: #c3c7cd;
  --text-muted: #8b9099;
  --text-faint: #666c74;

  /* At most twice in any one view. A third use is decoration. */
  --accent: #f2b544;
  --ok: #5ed6a0;
  --error: #e06c5c;

  --radius-card: 12px;
  --radius-control: 8px;
  --radius-pill: 999px;
  --shadow-card: 0 10px 34px rgba(0, 0, 0, 0.6);

  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
}

/*
 * The window is created transparent so the pill's glow is not drawn on a
 * black square. That means nothing paints a background unless it says so --
 * html and body must stay transparent, and each mode's root element paints
 * its own.
 */
html,
body {
  margin: 0;
  background: transparent;
  font-family: var(--font);
  color: var(--text);
  /* A frameless window has no titlebar to grab and no text worth selecting.
     Dragging that selects text instead of moving the window feels broken. */
  user-select: none;
  -webkit-user-select: none;
}

/* The one exception: the model's answer is worth copying out. */
.selectable {
  user-select: text;
  -webkit-user-select: text;
}

#root {
  height: 100vh;
}
```

- [ ] **Step 4: Import the tokens and fix the window chrome**

In `src/main.tsx`, add the stylesheet import above the `App` import:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "./ui/theme.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

In `index.html`, replace the `<title>` line:

```html
    <title>Mixing Pal</title>
```

In `src-tauri/tauri.conf.json`, replace the whole `"app"` object:

```json
  "app": {
    "macOSPrivateApi": true,
    "windows": [
      {
        "title": "Mixing Pal",
        "width": 320,
        "height": 480,
        "decorations": false,
        "transparent": true,
        "shadow": false,
        "resizable": false,
        "alwaysOnTop": true
      }
    ],
    "security": {
      "csp": null
    }
  },
```

Four of these are load-bearing and none is obvious:

- `macOSPrivateApi: true` is **required** for a transparent window on macOS. Without it the window renders opaque and the pill is a black square. It uses a private API, which is fine for direct `.dmg` distribution and would be rejected by the Mac App Store — a constraint for the distribution plan to record, not a problem here.
- `shadow: false` — macOS draws a rectangular system shadow around a transparent window, which appears as a grey box around the round pill. We draw our own shadow with `--shadow-card`.
- `decorations: false` — frameless, per the spec.
- `resizable: false` — every size is set programmatically by mode. A user-resized card would fight `set_window_mode` on the next transition.

`productName` and `identifier` stay exactly as they are. The rename belongs to the distribution plan.

- [ ] **Step 5: Run the tests and the typecheck**

Run: `npx vitest run src/ui/theme.test.ts 2>&1 | tee /tmp/t2.log && npm run build 2>&1 | tee -a /tmp/t2.log`
Expected: both tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/ui/theme.css src/ui/theme.test.ts src/main.tsx index.html src-tauri/tauri.conf.json
git commit -m "Add design tokens and a test that keeps them honest

One place for colour, radius, and type. The orphan-token test fails when
a stylesheet reads a custom property nobody defined -- var(--typo) renders
as nothing, which looks like a layout bug and gets debugged as one.

Window is now frameless and transparent. macOSPrivateApi is required for
transparency on macOS; shadow:false stops the system drawing a grey
rectangle around the round pill."
```

---

### Task 3: `set_window_mode`, and clamping a remembered position onto a real monitor

The Rust side of the mode machine. The interesting part is not resizing — it is that a position remembered from a two-monitor setup must not place the window off-screen when she is on the train with one.

**Files:**
- Create: `src-tauri/src/window.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod window;`, register the command)

**Interfaces:**
- Consumes: `WindowMode`'s three variants, matching `src/ui/windowMode.ts`'s `WindowMode` string union.
- Produces: Tauri command `set_window_mode(mode: WindowMode, width: u32, height: u32) -> Result<(), String>`, invoked from TypeScript as `invoke("set_window_mode", { mode, width, height })`. `pub fn clamp_to_visible(desired: Rect, monitors: &[Rect]) -> (i32, i32)`.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/window.rs` containing only the test module and the types it needs to compile — no logic yet:

```rust
use serde::Deserialize;

/// Mirrors src/ui/windowMode.ts's WindowMode. serde renames to snake_case
/// so the TypeScript string union crosses the IPC boundary unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WindowMode {
    Setup,
    Pill,
    Card,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn clamp_to_visible(_desired: Rect, _monitors: &[Rect]) -> (i32, i32) {
    unimplemented!()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LAPTOP: Rect = Rect { x: 0, y: 0, width: 1440, height: 900 };
    // A second display placed to the right, as macOS reports it.
    const EXTERNAL: Rect = Rect { x: 1440, y: 0, width: 2560, height: 1440 };

    #[test]
    fn a_window_fully_on_screen_is_left_alone() {
        let desired = Rect { x: 100, y: 100, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (100, 100));
    }

    #[test]
    fn a_window_hanging_off_the_right_edge_is_pulled_back_in() {
        let desired = Rect { x: 1400, y: 100, width: 320, height: 480 };
        // 1440 - 320 = 1120.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (1120, 100));
    }

    #[test]
    fn a_window_hanging_off_the_bottom_is_pulled_back_in() {
        let desired = Rect { x: 100, y: 880, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (100, 420));
    }

    #[test]
    fn a_negative_position_is_pulled_back_to_the_origin() {
        let desired = Rect { x: -50, y: -80, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (0, 0));
    }

    #[test]
    fn a_position_on_the_second_monitor_is_clamped_to_that_monitor() {
        // Mostly on the external display, hanging off its right edge.
        let desired = Rect { x: 3900, y: 200, width: 320, height: 480 };
        // 1440 + 2560 - 320 = 3680.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP, EXTERNAL]), (3680, 200));
    }

    #[test]
    fn a_position_on_a_monitor_that_is_gone_lands_on_the_one_that_is_left() {
        // Remembered from a session with the external display attached; she
        // is now on the laptop alone. Without this the card is invisible and
        // she has no titlebar to drag it back with.
        let desired = Rect { x: 3000, y: 400, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[LAPTOP]), (1120, 400));
    }

    #[test]
    fn the_monitor_holding_most_of_the_window_wins() {
        // Straddling the seam, with more area on the external display.
        let desired = Rect { x: 1380, y: 100, width: 320, height: 480 };
        // 60px on the laptop, 260px on the external -- so it belongs to the
        // external, whose left edge is 1440.
        assert_eq!(clamp_to_visible(desired, &[LAPTOP, EXTERNAL]), (1440, 100));
    }

    #[test]
    fn a_window_wider_than_its_monitor_pins_to_the_origin_rather_than_going_negative() {
        let small = Rect { x: 0, y: 0, width: 200, height: 200 };
        let desired = Rect { x: 50, y: 50, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[small]), (0, 0));
    }

    #[test]
    fn with_no_monitors_reported_the_desired_position_is_used_unchanged() {
        // Guessing is worse than trusting: an empty monitor list means the
        // platform did not tell us, not that there are no screens.
        let desired = Rect { x: 700, y: 300, width: 320, height: 480 };
        assert_eq!(clamp_to_visible(desired, &[]), (700, 300));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test window:: 2>&1 | tee /tmp/t3.log`

You must first add `mod window;` to `src-tauri/src/lib.rs` alongside the existing module declarations, or the file is never compiled. Do that now.

Expected: all nine tests FAIL with `not implemented`.

- [ ] **Step 3: Write the implementation**

Replace the `clamp_to_visible` stub in `src-tauri/src/window.rs`:

```rust
/// Area of the overlap between two rectangles, as i64 so a large monitor
/// times a large window cannot overflow.
fn overlap_area(a: Rect, b: Rect) -> i64 {
    let x = (a.x + a.width as i32).min(b.x + b.width as i32) - a.x.max(b.x);
    let y = (a.y + a.height as i32).min(b.y + b.height as i32) - a.y.max(b.y);
    if x <= 0 || y <= 0 {
        return 0;
    }
    x as i64 * y as i64
}

/// Where to actually put a window that would like to be at `desired`.
///
/// The failure this exists to prevent: she docks the card on an external
/// display, unplugs it, and reopens the app. The remembered position is on
/// a monitor that no longer exists, the window renders off-screen, and
/// because it is frameless there is no titlebar to drag it back with. The
/// only recovery would be deleting a settings file.
///
/// Picks the monitor holding the most of the window -- not the nearest
/// corner, which puts a window straddling the seam on the wrong screen.
pub fn clamp_to_visible(desired: Rect, monitors: &[Rect]) -> (i32, i32) {
    // An empty list means the platform did not tell us, not that there are
    // no screens. Trusting the caller beats inventing a screen.
    let Some(first) = monitors.first() else {
        return (desired.x, desired.y);
    };

    let home = monitors
        .iter()
        .max_by_key(|m| overlap_area(desired, **m))
        .copied()
        .unwrap_or(*first);

    // saturating_sub on the u32 subtraction: a window wider than its
    // monitor would otherwise wrap around to a vast positive number, and
    // the clamp below would shove it off the far edge.
    let max_x = home.x + home.width.saturating_sub(desired.width) as i32;
    let max_y = home.y + home.height.saturating_sub(desired.height) as i32;

    (
        desired.x.clamp(home.x, max_x),
        desired.y.clamp(home.y, max_y),
    )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd src-tauri && cargo test window:: 2>&1 | tee /tmp/t3.log`
Expected: PASS, 9 tests.

- [ ] **Step 5: Add the command and register it**

Append to `src-tauri/src/window.rs`:

```rust
use tauri::{LogicalSize, Manager, PhysicalPosition, PhysicalSize};

/// Applies a mode to the one window.
///
/// `width` and `height` come from the frontend because only the frontend
/// knows how tall the card's content is; the geometry table that produced
/// them lives in src/ui/windowMode.ts. Rust owns the parts the webview
/// cannot see: always-on-top, centring, and putting the window somewhere
/// a human can actually reach it.
#[tauri::command]
pub fn set_window_mode(
    app: tauri::AppHandle,
    mode: WindowMode,
    width: u32,
    height: u32,
) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;

    window
        .set_size(LogicalSize::new(width as f64, height as f64))
        .map_err(|e| e.to_string())?;

    window
        .set_always_on_top(!matches!(mode, WindowMode::Setup))
        .map_err(|e| e.to_string())?;

    if matches!(mode, WindowMode::Setup) {
        window.center().map_err(|e| e.to_string())?;
        return Ok(());
    }

    // Keep the pill and the card wherever she last dragged them, but never
    // outside a screen that currently exists.
    let Ok(current) = window.outer_position() else {
        return Ok(());
    };
    let Ok(size) = window.outer_size() else {
        return Ok(());
    };

    let monitors: Vec<Rect> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let p = m.position();
            let s = m.size();
            Rect { x: p.x, y: p.y, width: s.width, height: s.height }
        })
        .collect();

    let (x, y) = clamp_to_visible(
        Rect { x: current.x, y: current.y, width: size.width, height: size.height },
        &monitors,
    );

    if (x, y) != (current.x, current.y) {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }

    // Silences the unused-import warning when the PhysicalSize path below
    // is not taken; remove this line if PhysicalSize becomes used.
    let _ = PhysicalSize::<u32>::new(0, 0);
    Ok(())
}
```

Remove the trailing `PhysicalSize` placeholder line and its import if your compiler reports no warning without it — it exists only so the import list matches what a fuller implementation needs.

In `src-tauri/src/lib.rs`, add `set_window_mode` to the `invoke_handler` list:

```rust
        .invoke_handler(tauri::generate_handler![
            snapshot,
            connection_status,
            execute_tool,
            get_settings,
            save_settings,
            model_complete,
            trace,
            clear_trace,
            window::set_window_mode
        ])
```

And delete the now-redundant `window.set_always_on_top(true)?;` line in `setup()` — always-on-top is a per-mode property now, and leaving both means setup mode is on top for the first frame.

- [ ] **Step 6: Run the whole backend suite**

Run: `cd src-tauri && cargo test 2>&1 | tee /tmp/t3.log && cargo build 2>&1 | tee -a /tmp/t3.log`
Expected: all tests PASS, build succeeds with no warnings.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/window.rs src-tauri/src/lib.rs
git commit -m "Add set_window_mode and monitor-aware position clamping

Guards the failure where a position remembered on an external display
puts a frameless window off-screen after unplugging it -- no titlebar
means no way to drag it back, and the only recovery would be deleting a
settings file.

Picks the monitor holding the most of the window rather than the nearest
corner, so a window straddling the seam does not jump to the wrong screen.
Always-on-top moves out of setup() and becomes a per-mode property."
```

---

### Task 4: The pill

**Files:**
- Create: `src/ui/pillState.ts`
- Create: `src/ui/Pill.tsx`
- Create: `src/ui/Pill.css`
- Test: `src/ui/pillState.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type PillState = "idle" | "unread" | "thinking" | "disconnected"`; `function pillState(p: PillInput): PillState`; `<Pill state={...} onClick={...} />`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/pillState.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { pillState } from "./pillState";

const CONNECTED = { connected: true, unread: false, turnRunning: false };

describe("pillState", () => {
  it("is idle when connected with nothing happening", () => {
    expect(pillState(CONNECTED)).toBe("idle");
  });

  it("shows unread when something is waiting", () => {
    expect(pillState({ ...CONNECTED, unread: true })).toBe("unread");
  });

  it("shows thinking while a turn is running", () => {
    expect(pillState({ ...CONNECTED, turnRunning: true })).toBe("thinking");
  });

  it("prefers thinking over unread", () => {
    expect(pillState({ ...CONNECTED, turnRunning: true, unread: true })).toBe("thinking");
  });

  it("disconnected beats everything else", () => {
    expect(
      pillState({ connected: false, unread: true, turnRunning: true }),
    ).toBe("disconnected");
  });

  it("is disconnected when connected is false and nothing else is true", () => {
    expect(pillState({ connected: false, unread: false, turnRunning: false })).toBe(
      "disconnected",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/pillState.test.ts 2>&1 | tee /tmp/t4.log`
Expected: FAIL — cannot resolve `./pillState`.

- [ ] **Step 3: Write the state function**

Create `src/ui/pillState.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/pillState.test.ts 2>&1 | tee /tmp/t4.log`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the component and its stylesheet**

Create `src/ui/Pill.css`:

```css
/*
 * Three of the four states are a 26px dot in a 44px window. Only the
 * failure state has words -- a broken connection is the one thing Live
 * will never tell her.
 */
.pill {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pill__body {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  box-shadow: var(--shadow-card);
  width: 26px;
  height: 26px;
  justify-content: center;
  cursor: pointer;
}

.pill__dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  background: var(--text-faint);
}

.pill--unread .pill__body {
  border-color: rgba(242, 181, 68, 0.35);
  box-shadow: var(--shadow-card), 0 0 14px rgba(242, 181, 68, 0.18);
}

.pill--unread .pill__dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
  box-shadow: 0 0 8px rgba(242, 181, 68, 0.9);
}

.pill--thinking .pill__dot {
  background: var(--text-muted);
  animation: pill-breathe 2s ease-in-out infinite;
}

/* Opacity only. Anything that moves in the corner of someone's eye for
   hours is an irritant, and this pill can be on screen all evening. */
@keyframes pill-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pill--thinking .pill__dot {
    animation: none;
    opacity: 0.7;
  }
}

.pill--disconnected .pill__body {
  width: auto;
  height: auto;
  padding: 5px 12px;
  border-color: rgba(224, 108, 92, 0.35);
}

.pill--disconnected .pill__dot {
  background: var(--error);
}

.pill__label {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}
```

Create `src/ui/Pill.tsx`:

```tsx
import { PillState } from "./pillState";

/**
 * The collapsed window. `data-tauri-drag-region` on the body makes the
 * whole pill a drag handle -- there is no titlebar, so without it she has
 * no way to move the window at all.
 */
export function Pill({ state, onClick }: { state: PillState; onClick: () => void }) {
  return (
    <div className={`pill pill--${state}`}>
      <div
        className="pill__body"
        data-tauri-drag-region
        onClick={onClick}
        title={state === "disconnected" ? "Not connected to Live" : "Mixing Pal"}
      >
        <span className="pill__dot" />
        {state === "disconnected" && <span className="pill__label">not connected</span>}
      </div>
    </div>
  );
}
```

Add the import to `src/ui/theme.css`'s consumers by importing the stylesheet at the top of `Pill.tsx`:

```tsx
import "./Pill.css";
import { PillState } from "./pillState";
```

- [ ] **Step 6: Run the token test and the typecheck**

The orphan-token test from Task 2 now has a real stylesheet to check.

Run: `npx vitest run 2>&1 | tee /tmp/t4.log && npm run build 2>&1 | tee -a /tmp/t4.log`
Expected: all tests PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/ui/pillState.ts src/ui/pillState.test.ts src/ui/Pill.tsx src/ui/Pill.css
git commit -m "Add the pill

Four states, three of them a dot. Only the disconnected state has words:
a broken connection is the one thing Live will never tell her.

The breathe animation is opacity-only and respects prefers-reduced-motion
-- anything that moves in the corner of someone's eye for hours is an
irritant, and this can be on screen all evening."
```

---

### Task 5: The progress line

`Chat.tsx` currently prints `reading get_track_detail({"index":3})…`. That is a debugger talking. This is the pure function that turns a tool call into a sentence about the producer's music.

**Files:**
- Create: `src/ui/progressLabel.ts`
- Test: `src/ui/progressLabel.test.ts`

**Interfaces:**
- Consumes: `SetState` from `src/live/model.ts`.
- Produces: `function progressLabel(name: string, args: unknown, state: SetState): string`.

Both backend tools take a `track` argument; `get_clip_notes` also takes `clip`. Those names are from `src-tauri/src/tools/mod.rs:95` and `:109-110` — do not guess them.

- [ ] **Step 1: Write the failing test**

Create `src/ui/progressLabel.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { progressLabel } from "./progressLabel";
import { SetState } from "../live/model";
import { emptyTrack } from "../live/model";

const STATE: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: "Minor",
  rootNote: 9,
  selectedTrack: 1,
  scriptVersion: 2,
  tracks: {
    0: { ...emptyTrack(), name: "Kick" },
    1: { ...emptyTrack(), name: "Pad Wide" },
    2: { ...emptyTrack(), name: null },
  },
};

describe("progressLabel", () => {
  it("names the track a track lookup is about", () => {
    expect(progressLabel("get_track_detail", { track: 1 }, STATE)).toBe("reading Pad Wide…");
  });

  it("names the track a note lookup is about", () => {
    expect(progressLabel("get_clip_notes", { track: 0, clip: 2 }, STATE)).toBe(
      "reading the notes in Kick…",
    );
  });

  it("falls back per tool when the track index is not in the mirror", () => {
    expect(progressLabel("get_track_detail", { track: 99 }, STATE)).toBe("reading a track…");
    expect(progressLabel("get_clip_notes", { track: 99, clip: 0 }, STATE)).toBe(
      "reading the clip…",
    );
  });

  it("falls back when the mirror has the track but not its name yet", () => {
    expect(progressLabel("get_track_detail", { track: 2 }, STATE)).toBe("reading a track…");
  });

  it("falls back when the argument is missing or the wrong type", () => {
    expect(progressLabel("get_track_detail", {}, STATE)).toBe("reading a track…");
    expect(progressLabel("get_track_detail", { track: "1" }, STATE)).toBe("reading a track…");
    expect(progressLabel("get_track_detail", null, STATE)).toBe("reading a track…");
  });

  it("has something to say about a tool it has never heard of", () => {
    expect(progressLabel("get_future_thing", { track: 1 }, STATE)).toBe("reading…");
  });

  // The whole point of this function. A regression here puts JSON back on
  // screen, which is what it was written to remove.
  it("never leaks raw arguments or the function name", () => {
    for (const [name, args] of [
      ["get_track_detail", { track: 1 }],
      ["get_track_detail", { track: 99 }],
      ["get_clip_notes", { track: 0, clip: 2 }],
      ["get_future_thing", { track: 1 }],
    ] as const) {
      const label = progressLabel(name, args, STATE);
      expect(label).not.toContain("{");
      expect(label).not.toContain("_");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/progressLabel.test.ts 2>&1 | tee /tmp/t5.log`
Expected: FAIL — cannot resolve `./progressLabel`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/progressLabel.ts`:

```ts
import { SetState } from "../live/model";

/**
 * What the producer sees while the model is fetching something.
 *
 * The rule is that this names her music, never our code. `reading Pad
 * Wide…` tells her the model is looking at the thing she just asked
 * about; `reading get_track_detail({"track":1})…` tells her she is using
 * a debugger. The raw calls are still available in the trace pane, which
 * is where a debugger belongs.
 *
 * Argument names come from the tool schema in src-tauri/src/tools/mod.rs.
 * Both tools take `track`; get_clip_notes also takes `clip`.
 */
const PHRASE: Record<string, (trackName: string) => string> = {
  get_track_detail: (t) => `reading ${t}…`,
  get_clip_notes: (t) => `reading the notes in ${t}…`,
};

const FALLBACK: Record<string, string> = {
  get_track_detail: "reading a track…",
  get_clip_notes: "reading the clip…",
};

function trackName(args: unknown, state: SetState): string | null {
  if (typeof args !== "object" || args === null) return null;
  const track = (args as Record<string, unknown>).track;
  if (typeof track !== "number") return null;
  // A track in the mirror whose name has not arrived yet is no better than
  // an unknown track -- "reading null…" would be worse than the fallback.
  return state.tracks[track]?.name ?? null;
}

export function progressLabel(name: string, args: unknown, state: SetState): string {
  const resolved = trackName(args, state);
  const phrase = PHRASE[name];
  if (resolved !== null && phrase !== undefined) return phrase(resolved);
  // A tool added later gets a plain sentence rather than leaking its name.
  return FALLBACK[name] ?? "reading…";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/progressLabel.test.ts 2>&1 | tee /tmp/t5.log`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/ui/progressLabel.ts src/ui/progressLabel.test.ts
git commit -m "Add the progress line

Names her music, never our code. The leak test is the point: a regression
here puts JSON back on screen, which is what this was written to remove.

Argument names are read from the tool schema in tools/mod.rs, not guessed."
```

---

### Task 6: The goal, extracted from the chat pane

The goal is the highest-leverage field in the design and it is currently trapped inside `Chat.tsx` with its persistence helpers. Extract it so the header can own it and so the throw-safety can finally be tested.

**Files:**
- Create: `src/ui/goal.ts`
- Test: `src/ui/goal.test.ts`
- Modify: `src/ui/Chat.tsx` (remove `loadStoredGoal`, `GOAL_STORAGE_KEY`, and the inline `setItem` call; import from `./goal`)

**Interfaces:**
- Consumes: nothing.
- Produces: `const GOAL_STORAGE_KEY: string`; `const GOAL_MAX_LENGTH = 500`; `function loadGoal(): string`; `function saveGoal(value: string): void`.

- [ ] **Step 1: Write the failing test**

Create `src/ui/goal.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { loadGoal, saveGoal, GOAL_STORAGE_KEY } from "./goal";

function stubStorage(impl: Partial<Storage>) {
  vi.stubGlobal("localStorage", impl as Storage);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadGoal", () => {
  it("returns the stored goal", () => {
    stubStorage({ getItem: () => "dark garage, 2am" });
    expect(loadGoal()).toBe("dark garage, 2am");
  });

  it("returns empty on a first run with nothing stored", () => {
    stubStorage({ getItem: () => null });
    expect(loadGoal()).toBe("");
  });

  // This runs inside a useState initializer during render. An uncaught
  // throw there unmounts the whole pane rather than losing one string --
  // some webview storage configurations raise SecurityError on access.
  it("returns empty rather than throwing when storage is unavailable", () => {
    stubStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });
    expect(loadGoal()).toBe("");
  });

  it("survives storage being absent entirely", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadGoal()).toBe("");
  });
});

describe("saveGoal", () => {
  it("writes under the documented key", () => {
    const setItem = vi.fn();
    stubStorage({ setItem });
    saveGoal("dark garage, 2am");
    expect(setItem).toHaveBeenCalledWith(GOAL_STORAGE_KEY, "dark garage, 2am");
  });

  // Called from an input handler on every keystroke. A throw here would
  // break typing in the field, which is far worse than losing persistence.
  it("swallows a failing write rather than breaking the keystroke", () => {
    stubStorage({
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });
    expect(() => saveGoal("x")).not.toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/goal.test.ts 2>&1 | tee /tmp/t6.log`
Expected: FAIL — cannot resolve `./goal`.

- [ ] **Step 3: Write the implementation**

Create `src/ui/goal.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/goal.test.ts 2>&1 | tee /tmp/t6.log`
Expected: PASS, 6 tests.

- [ ] **Step 5: Point `Chat.tsx` at the new module**

In `src/ui/Chat.tsx`, delete `GOAL_STORAGE_KEY`, `loadStoredGoal`, and their comments, and replace the `useState`/`onChange` pair to use the imports. `Chat.tsx` is replaced wholesale in Task 8, but it must keep compiling and passing tests in between.

```tsx
import { loadGoal, saveGoal, GOAL_MAX_LENGTH } from "./goal";
```

```tsx
  const [goal, setGoal] = useState(loadGoal);
```

```tsx
        maxLength={GOAL_MAX_LENGTH}
        onChange={(e) => {
          setGoal(e.target.value);
          saveGoal(e.target.value);
        }}
```

- [ ] **Step 6: Run the whole suite and the typecheck**

Run: `npx vitest run 2>&1 | tee /tmp/t6.log && npm run build 2>&1 | tee -a /tmp/t6.log`
Expected: all PASS; build succeeds.

- [ ] **Step 7: Commit**

```bash
git add src/ui/goal.ts src/ui/goal.test.ts src/ui/Chat.tsx
git commit -m "Extract the goal field's persistence out of Chat.tsx

The throw-safety in both helpers was load-bearing and untested. It now has
tests: loadGoal runs inside a useState initializer, where an uncaught
throw unmounts the pane rather than losing a string, and saveGoal runs on
every keystroke, where a throw breaks typing in the field."
```

---

### Task 7: The nudge rule and the cooldown

One rule ships: `unnamedTracks`. It is chosen because it is the one rule that cannot be wrong, and a wrong first nudge costs more trust than a missing one.

**Files:**
- Create: `src/rules/unnamedTracks.ts`
- Create: `src/rules/nudges.ts`
- Test: `src/rules/unnamedTracks.test.ts`
- Test: `src/rules/nudges.test.ts`

**Interfaces:**
- Consumes: `SetState` from `src/live/model.ts`.
- Produces: `interface Nudge { id: string; text: string }`; `function unnamedTracks(state: SetState): Nudge | null`; `interface NudgeState`; `const EMPTY_NUDGE_STATE: NudgeState`; `const COOLDOWN_MS: number`; `function offer(state: NudgeState, candidate: Nudge | null, now: number): NudgeState`; `function dismiss(state: NudgeState, id: string): NudgeState`.

- [ ] **Step 1: Write the failing tests**

Create `src/rules/unnamedTracks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { unnamedTracks, MIN_UNNAMED, MIN_TRACKS } from "./unnamedTracks";
import { SetState, emptyTrack } from "../live/model";

function setOf(names: Array<string | null>): SetState {
  const tracks: SetState["tracks"] = {};
  names.forEach((name, i) => {
    tracks[i] = { ...emptyTrack(), name };
  });
  return {
    tempo: 128,
    isPlaying: false,
    scaleName: null,
    rootNote: null,
    selectedTrack: null,
    scriptVersion: 2,
    tracks,
  };
}

const NAMED = ["Kick", "Snare", "808 Sub", "Pad Wide", "Vox Chop"];

describe("unnamedTracks", () => {
  it("fires when enough tracks in a big enough set still carry default names", () => {
    const state = setOf([
      ...NAMED,
      "1 MIDI",
      "2 MIDI",
      "3 Audio",
      "4 Audio",
      "5 MIDI",
      "6 MIDI",
    ]);
    expect(unnamedTracks(state)).toEqual({
      id: "unnamed_tracks",
      text: "Six tracks are still named MIDI or Audio.",
    });
  });

  it("stays quiet in a small set, however scruffy", () => {
    const state = setOf(["1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI", "6 MIDI"]);
    expect(state.tracks[0]).toBeDefined();
    expect(unnamedTracks(state)).toBeNull();
  });

  it("stays quiet when only a few are unnamed", () => {
    const state = setOf([...NAMED, "Bass", "Hat", "Ride", "Perc", "1 MIDI", "2 Audio"]);
    expect(unnamedTracks(state)).toBeNull();
  });

  it("spells the count in words up to ten and uses digits past it", () => {
    const seven = setOf([
      ...NAMED,
      "1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI", "6 MIDI", "7 MIDI",
    ]);
    expect(unnamedTracks(seven)?.text).toBe("Seven tracks are still named MIDI or Audio.");

    const eleven = setOf([
      ...NAMED,
      "1 MIDI", "2 MIDI", "3 MIDI", "4 MIDI", "5 MIDI",
      "6 MIDI", "7 MIDI", "8 MIDI", "9 MIDI", "10 MIDI", "11 MIDI",
    ]);
    expect(unnamedTracks(eleven)?.text).toBe("11 tracks are still named MIDI or Audio.");
  });

  it("recognises the default shapes Live can produce", () => {
    const state = setOf([
      ...NAMED,
      "MIDI", "Audio", "1 MIDI", "2-Audio", "3 midi", "4 AUDIO",
    ]);
    expect(unnamedTracks(state)?.text).toBe("Six tracks are still named MIDI or Audio.");
  });

  it("does not count a track the producer deliberately named", () => {
    const state = setOf([
      ...NAMED,
      "MIDI Bus", "Audio Ref", "Sub MIDI", "1 MIDI", "2 MIDI", "3 MIDI",
    ]);
    // Only the three bare defaults count, which is below the threshold.
    expect(unnamedTracks(state)).toBeNull();
  });

  it("does not count a track whose name has not arrived from Live yet", () => {
    const state = setOf([
      ...NAMED,
      null, null, null, null, null, null,
    ]);
    expect(unnamedTracks(state)).toBeNull();
  });

  it("exposes its thresholds so the copy and the test cannot drift", () => {
    expect(MIN_UNNAMED).toBe(6);
    expect(MIN_TRACKS).toBe(10);
  });
});
```

Create `src/rules/nudges.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { offer, dismiss, EMPTY_NUDGE_STATE, COOLDOWN_MS } from "./nudges";

const NUDGE = { id: "unnamed_tracks", text: "Six tracks are still named MIDI or Audio." };
const T0 = 1_000_000;

describe("offer", () => {
  it("shows a nudge when nothing has fired before", () => {
    const next = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(next.current).toEqual(NUDGE);
    expect(next.lastFiredAt).toBe(T0);
  });

  it("holds the nudge while it is still on screen", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(offer(shown, NUDGE, T0 + 1000).current).toEqual(NUDGE);
  });

  it("refuses a new nudge inside the cooldown", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(dismissed, other, T0 + COOLDOWN_MS - 1).current).toBeNull();
  });

  it("allows a new nudge once the cooldown has passed", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(dismissed, other, T0 + COOLDOWN_MS).current).toEqual(other);
  });

  // Otherwise the same true observation reappears every two seconds for the
  // rest of the session, which is how a helpful nudge becomes an enemy.
  it("never re-raises a nudge she dismissed, however long it has been", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const dismissed = dismiss(shown, NUDGE.id);
    expect(offer(dismissed, NUDGE, T0 + COOLDOWN_MS * 10).current).toBeNull();
  });

  it("clears the slot when the condition stops holding", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    expect(offer(shown, null, T0 + 1000).current).toBeNull();
  });

  it("does not start the cooldown when there was nothing to show", () => {
    expect(offer(EMPTY_NUDGE_STATE, null, T0).lastFiredAt).toBeNull();
  });

  it("holds one nudge at a time", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const other = { id: "master_level_high", text: "Master has been near full scale." };
    expect(offer(shown, other, T0 + COOLDOWN_MS * 2).current).toEqual(NUDGE);
  });

  it("keeps a ten-minute cooldown", () => {
    expect(COOLDOWN_MS).toBe(10 * 60 * 1000);
  });
});

describe("dismiss", () => {
  it("clears the slot and remembers the id", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const next = dismiss(shown, NUDGE.id);
    expect(next.current).toBeNull();
    expect(next.dismissed).toContain(NUDGE.id);
  });

  it("does not accumulate duplicates", () => {
    const shown = offer(EMPTY_NUDGE_STATE, NUDGE, T0);
    const twice = dismiss(dismiss(shown, NUDGE.id), NUDGE.id);
    expect(twice.dismissed).toEqual([NUDGE.id]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/rules 2>&1 | tee /tmp/t7.log`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the rule**

Create `src/rules/unnamedTracks.ts`:

```ts
import { SetState } from "../live/model";
import { Nudge } from "./nudges";

/**
 * Live's default track names. Verified shapes: a bare "MIDI"/"Audio" and a
 * numbered "1 MIDI"/"2-Audio". Case-insensitive because the exact casing
 * is not worth depending on.
 *
 * Anchored at both ends on purpose: "MIDI Bus" and "Sub MIDI" are names
 * the producer chose, and counting them would make this rule wrong -- which
 * is the one thing it must never be.
 *
 * MANUAL VERIFICATION REQUIRED: confirm against a real Live 12 set before
 * trusting this rule. See docs/manual-verification.md.
 */
export const DEFAULT_NAME = /^(?:\d+[-\s]+)?(?:MIDI|Audio)$/i;

/** Below this many defaults it is tidiness, not a problem worth a nudge. */
export const MIN_UNNAMED = 6;

/** Below this many tracks it is a sketch, and naming things is premature. */
export const MIN_TRACKS = 10;

const WORDS = [
  "Zero", "One", "Two", "Three", "Four", "Five",
  "Six", "Seven", "Eight", "Nine", "Ten",
];

/**
 * Numbers up to ten in words. The nudge sits next to the model's prose and
 * should read in the same register -- "Seven tracks", not "7 tracks", which
 * is the register of a linter.
 */
function spell(n: number): string {
  return WORDS[n] ?? String(n);
}

/**
 * Fires when a set has grown past sketch size and most of it is still
 * called MIDI and Audio.
 *
 * This is the first nudge that ships, and it was chosen because it cannot
 * be wrong: it is a count of strings, with no inference and no judgement
 * about the music. A wrong nudge costs more trust than a missing one.
 */
export function unnamedTracks(state: SetState): Nudge | null {
  const names = Object.values(state.tracks).map((t) => t.name);
  if (names.length < MIN_TRACKS) return null;

  // A null name is a track whose name has not arrived from Live yet, not a
  // track called nothing. Counting it would make the nudge fire during the
  // first second of every session, before the mirror has filled in.
  const count = names.filter((n) => n !== null && DEFAULT_NAME.test(n)).length;
  if (count < MIN_UNNAMED) return null;

  return {
    id: "unnamed_tracks",
    text: `${spell(count)} tracks are still named MIDI or Audio.`,
  };
}
```

- [ ] **Step 4: Write the cooldown reducer**

Create `src/rules/nudges.ts`:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/rules 2>&1 | tee /tmp/t7.log`
Expected: PASS, 19 tests.

- [ ] **Step 6: Record the manual verification the rule depends on**

Append to `docs/manual-verification.md`, in the checklist:

```markdown
- [ ] Confirm Live 12's default track names against `DEFAULT_NAME` in
      `src/rules/unnamedTracks.ts`. Create a fresh set, add six MIDI tracks
      and six audio tracks without renaming any, and read the names Live
      gives them off the track headers. The regex matches a bare `MIDI`/
      `Audio` and a numbered `1 MIDI`/`2-Audio`, case-insensitively. If Live
      produces a shape it does not match, the nudge never fires and the
      failure is silent — the rule simply stays quiet forever. Fix the regex
      and its test together.
```

- [ ] **Step 7: Commit**

```bash
git add src/rules docs/manual-verification.md
git commit -m "Add the unnamed_tracks rule and the nudge cooldown

The first nudge that ships, chosen because it cannot be wrong: a count of
strings, no inference, no judgement about the music. A wrong nudge costs
more trust than a missing one.

The reducer's job is stopping a true observation from reappearing every
two seconds, which is how a helpful nudge becomes an enemy: dismissal is
permanent for the session, and re-offering a nudge already on screen does
not restart its cooldown.

The default-name regex needs checking against real Live 12 -- if it is
wrong the rule fails silently by never firing, so it is on the manual
verification list."
```

---

### Task 8: The card

The visible product: header, nudge slot, one exchange, input, disclaimer. This replaces `Chat.tsx`.

**Files:**
- Create: `src/ui/Card.tsx`
- Create: `src/ui/Card.css`
- Create: `src/ui/Conversation.tsx`
- Create: `src/ui/Header.tsx`
- Create: `src/ui/Noticed.tsx`
- Delete: `src/ui/Chat.tsx`

**Interfaces:**
- Consumes: `loadGoal`/`saveGoal`/`GOAL_MAX_LENGTH` (Task 6), `progressLabel` (Task 5), `Nudge` (Task 7), `runTurn`/`ChatMessage` from `src/agent/loop.ts`, `tauriProvider`/`tauriTools` from `src/model/provider.ts`, `buildContext` from `src/digest/build.ts`, `parseMarkdown`/`BlockNode` from `src/ui/markdown.ts`.
- Produces: `<Card state={SetState} nudge={Nudge | null} onDismissNudge={(id: string) => void} connected={boolean} onTurnRunningChange={(running: boolean) => void} onAnswer={() => void} onCollapse={() => void} />`.

Reading model 2: **only the current exchange is on screen.** `runTurn` still receives the full history — that is a different thing and must not be confused with it.

- [ ] **Step 1: Write the header**

Create `src/ui/Header.tsx`:

```tsx
import { useState } from "react";
import { GOAL_MAX_LENGTH } from "./goal";

/**
 * Three elements and nothing else: is it connected, what is she making,
 * and a way to close.
 *
 * No tempo, no key, no track count. Live shows all three, larger and more
 * accurately, and mirroring them would make this a worse copy of a window
 * that is already open. They live in the disclosure below, where the job
 * is proof rather than information.
 */
export function Header({
  connected,
  goal,
  onGoalChange,
  onCollapse,
}: {
  connected: boolean;
  goal: string;
  onGoalChange: (value: string) => void;
  onCollapse: () => void;
}) {
  const [editing, setEditing] = useState(false);

  return (
    <div className="card__header" data-tauri-drag-region>
      <span className={`card__dot ${connected ? "card__dot--ok" : "card__dot--error"}`} />
      {editing ? (
        <input
          className="card__goal-input"
          autoFocus
          value={goal}
          maxLength={GOAL_MAX_LENGTH}
          placeholder="What are you making?"
          onChange={(e) => onGoalChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => e.key === "Enter" && setEditing(false)}
        />
      ) : (
        <button className="card__goal" onClick={() => setEditing(true)}>
          {goal.trim() === "" ? "What are you making?" : goal}
        </button>
      )}
      <button className="card__chevron" onClick={onCollapse} title="Collapse">
        ⌄
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Write the nudge slot**

Create `src/ui/Noticed.tsx`:

```tsx
import { Nudge } from "../rules/nudges";

/**
 * One nudge at a time, always dismissible. The accent rule down the left
 * is one of the two places the accent appears in this view; the other is
 * the unread pill. A third would be decoration.
 */
export function Noticed({ nudge, onDismiss }: { nudge: Nudge; onDismiss: () => void }) {
  return (
    <div className="card__noticed">
      <span className="card__noticed-rule" />
      <div className="card__noticed-body">
        <div className="card__label">Noticed</div>
        <div className="card__noticed-text">{nudge.text}</div>
      </div>
      <button className="card__dismiss" onClick={onDismiss} title="Dismiss">
        ×
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write the conversation**

Create `src/ui/Conversation.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { SetState } from "../live/model";
import { ChatMessage, runTurn } from "../agent/loop";
import { tauriProvider, tauriTools } from "../model/provider";
import { buildContext } from "../digest/build";
import { BlockNode, InlineNode, parseMarkdown } from "./markdown";
import { progressLabel } from "./progressLabel";

function renderInline(nodes: InlineNode[]): ReactNode {
  return nodes.map((n, i) => {
    switch (n.type) {
      case "text":
        return n.text;
      case "bold":
        return <strong key={i}>{renderInline(n.children)}</strong>;
      case "italic":
        return <em key={i}>{renderInline(n.children)}</em>;
      case "code":
        return (
          <code key={i} className="card__code">
            {n.text}
          </code>
        );
      // A name that came from her project, not from the model. Faint and
      // muted on purpose -- it should read as "this is yours", not compete
      // with the model's own words.
      case "fence":
        return (
          <span key={i} className="card__fence">
            {n.name}
          </span>
        );
    }
  });
}

function renderBlocks(blocks: BlockNode[]): ReactNode {
  return blocks.map((b, i) => {
    switch (b.type) {
      case "paragraph":
        return (
          <p key={i} className="card__paragraph">
            {renderInline(b.children)}
          </p>
        );
      // Rendered as an emphasised line, never large type: this is a narrow
      // always-on-top pane, not a document.
      case "heading":
        return (
          <div key={i} className="card__subhead">
            {renderInline(b.children)}
          </div>
        );
      case "list":
        return b.ordered ? (
          <ol key={i} className="card__list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ol>
        ) : (
          <ul key={i} className="card__list">
            {b.items.map((item, j) => (
              <li key={j}>{renderInline(item)}</li>
            ))}
          </ul>
        );
      case "code_block":
        return (
          <pre key={i} className="card__code-block">
            {b.text}
          </pre>
        );
    }
  });
}

/**
 * Reading model 2: only the current exchange is on screen.
 *
 * `history` still holds the whole conversation and the whole thing goes to
 * the model on every turn -- that is a separate concern from what she
 * looks at. The session reader that surfaces the rest is a later plan.
 */
export function Conversation({
  state,
  goal,
  onTurnRunningChange,
  onAnswer,
}: {
  state: SetState;
  goal: string;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
}) {
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    const asked = input.trim();
    if (asked === "" || busy) return;
    setInput("");
    setError(null);
    setAnswer(null);
    setQuestion(asked);
    setBusy(true);
    onTurnRunningChange(true);

    // The context block rides ahead of the question as an ordinary user
    // turn, rebuilt each time so it reflects the set as it is now, not as
    // it was when the conversation started.
    const turn: ChatMessage[] = [
      ...history,
      { role: "user", content: `${buildContext(state, goal)}\n\n---\n\n${asked}` },
    ];
    setHistory([...history, { role: "user", content: asked }]);

    try {
      const out = await runTurn(tauriProvider, tauriTools, turn, (name, args) =>
        setProgress(progressLabel(name, args, state)),
      );
      setHistory((h) => [...h, { role: "assistant", content: out.text }]);
      setAnswer(out.text);
      onAnswer();
    } catch (e) {
      // Provider errors surface as text and the app keeps running.
      setError(String(e));
    } finally {
      setProgress(null);
      setBusy(false);
      onTurnRunningChange(false);
    }
  }

  return (
    <>
      <div className="card__body">
        {question !== null && <div className="card__question">{question}</div>}
        {answer !== null && (
          <div className="card__answer selectable">{renderBlocks(parseMarkdown(answer))}</div>
        )}
        {progress !== null && <div className="card__progress">{progress}</div>}
        {error !== null && <div className="card__error selectable">{error}</div>}
      </div>
      <div className="card__footer">
        <input
          className="card__input"
          value={input}
          placeholder="Ask about the set…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
        {/* Permanent and non-dismissible. From here the app can state wrong
            things fluently, in prose, about her music, and it cannot hear
            any of it. */}
        <div className="card__disclaimer">AI can make mistakes. Treat responses as suggestions.</div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Write the card and its stylesheet**

Create `src/ui/Card.tsx`:

```tsx
import { useState } from "react";
import "./Card.css";
import { SetState } from "../live/model";
import { Nudge } from "../rules/nudges";
import { loadGoal, saveGoal } from "./goal";
import { Header } from "./Header";
import { Noticed } from "./Noticed";
import { Conversation } from "./Conversation";
import { WhatICanSee } from "./WhatICanSee";
import { Connection } from "./Connection";

export function Card({
  state,
  lastSeen,
  connected,
  nudge,
  onDismissNudge,
  onTurnRunningChange,
  onAnswer,
  onCollapse,
}: {
  state: SetState;
  lastSeen: number | null;
  connected: boolean;
  nudge: Nudge | null;
  onDismissNudge: (id: string) => void;
  onTurnRunningChange: (running: boolean) => void;
  onAnswer: () => void;
  onCollapse: () => void;
}) {
  const [goal, setGoal] = useState(loadGoal);

  return (
    <div className="card">
      <Header
        connected={connected}
        goal={goal}
        onGoalChange={(v) => {
          setGoal(v);
          saveGoal(v);
        }}
        onCollapse={onCollapse}
      />
      <Connection lastSeen={lastSeen} scriptVersion={state.scriptVersion} />
      {nudge !== null && <Noticed nudge={nudge} onDismiss={() => onDismissNudge(nudge.id)} />}
      <Conversation
        state={state}
        goal={goal}
        onTurnRunningChange={onTurnRunningChange}
        onAnswer={onAnswer}
      />
      <WhatICanSee state={state} />
    </div>
  );
}
```

Create `src/ui/Card.css`:

```css
.card {
  display: flex;
  flex-direction: column;
  max-height: 100vh;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  overflow: hidden;
}

.card__header {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 11px 15px;
  border-bottom: 1px solid var(--border);
}

.card__dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  flex: none;
}

.card__dot--ok {
  background: var(--ok);
  box-shadow: 0 0 7px rgba(94, 214, 160, 0.55);
}

.card__dot--error {
  background: var(--error);
}

/* The goal is dim because she wrote it -- it needs to be visible, not read. */
.card__goal,
.card__goal-input {
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  color: var(--text-muted);
  text-align: left;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
  cursor: pointer;
}

.card__goal-input {
  color: var(--text-secondary);
  cursor: text;
  outline: none;
}

.card__chevron,
.card__dismiss {
  background: none;
  border: none;
  padding: 0 2px;
  font-size: 12px;
  color: var(--text-faint);
  cursor: pointer;
}

.card__noticed {
  display: flex;
  gap: 11px;
  align-items: flex-start;
  padding: 13px 15px;
  border-bottom: 1px solid var(--border);
}

.card__noticed-rule {
  width: 2px;
  align-self: stretch;
  border-radius: 2px;
  background: var(--accent);
  opacity: 0.75;
  flex: none;
}

.card__noticed-body {
  flex: 1;
}

.card__noticed-text {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.card__label {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--text-muted);
  margin-bottom: 5px;
}

.card__body {
  padding: 15px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.card__question {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-muted);
  margin-bottom: 12px;
}

/* The largest and lightest text in the app. Everything the app measured is
   dimmer and smaller than this -- that contrast is how she can tell what
   was read from what was generated. */
.card__answer {
  font-size: 14px;
  line-height: 1.68;
  color: var(--text);
}

.card__paragraph {
  margin: 0 0 10px;
}

.card__paragraph:last-child {
  margin-bottom: 0;
}

.card__subhead {
  font-weight: 600;
  opacity: 0.85;
  margin: 0 0 6px;
}

.card__list {
  margin: 2px 0 10px;
  padding-left: 20px;
}

.card__code,
.card__code-block {
  font: 12px ui-monospace, monospace;
  background: rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  padding: 0 4px;
}

.card__code-block {
  display: block;
  padding: 8px;
  overflow-x: auto;
}

.card__fence {
  background: rgba(255, 255, 255, 0.07);
  border-radius: 5px;
  padding: 1px 6px;
  color: var(--text-muted);
}

.card__progress {
  font-size: 13px;
  color: var(--text-faint);
}

.card__error {
  font-size: 13px;
  line-height: 1.55;
  color: var(--text-secondary);
  background: rgba(224, 108, 92, 0.1);
  border: 1px solid rgba(224, 108, 92, 0.28);
  border-radius: var(--radius-control);
  padding: 10px 12px;
}

.card__footer {
  padding: 12px 15px;
  border-top: 1px solid var(--border);
}

.card__input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 8px 10px;
  font: inherit;
  font-size: 14px;
  color: var(--text);
  outline: none;
}

.card__input::placeholder {
  color: var(--text-faint);
}

.card__input:focus {
  border-color: var(--border-strong);
}

.card__disclaimer {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
  margin-top: 8px;
}
```

- [ ] **Step 5: Delete the old chat pane**

```bash
git rm src/ui/Chat.tsx
```

`Chat.tsx` is replaced entirely. `App.tsx` still imports it and will not compile until Task 11 — that is expected and it is why this task's verification is the test suite, not the build.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run 2>&1 | tee /tmp/t8.log`
Expected: all PASS. The orphan-token test now covers `Card.css` and must stay green.

- [ ] **Step 7: Commit**

```bash
git add src/ui/Card.tsx src/ui/Card.css src/ui/Conversation.tsx src/ui/Header.tsx src/ui/Noticed.tsx
git commit -m "Add the card, replacing the chat pane

Reading model 2: only the current exchange is on screen. The full history
still goes to the model on every turn -- that is a separate concern from
what she looks at, and the session reader is a later plan.

The header holds three things and no tempo, key, or track count. Live
shows all three, larger and more accurately.

Note: App.tsx does not compile until Task 11 wires this up."
```

---

### Task 9: What I can see

`SetView.tsx`'s track table, demoted to a collapsed disclosure. This is where the mirrored data goes, and its one job is proof that the app really reads the set.

**Files:**
- Create: `src/ui/WhatICanSee.tsx`
- Create: `src/ui/WhatICanSee.css`
- Create: `src/ui/summaryLine.ts`
- Test: `src/ui/summaryLine.test.ts`
- Delete: `src/ui/SetView.tsx`

**Interfaces:**
- Consumes: `SetState`, `keyName` from `src/digest/build.ts`.
- Produces: `function summaryLine(state: SetState, trackCount: number): string`; `<WhatICanSee state={SetState} />`.

- [ ] **Step 1: Write the failing test**

`summaryLine` exists in `SetView.tsx` today with no test. Extracting it gives it one.

Create `src/ui/summaryLine.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { summaryLine } from "./summaryLine";
import { SetState } from "../live/model";

const BASE: SetState = {
  tempo: 128,
  isPlaying: false,
  scaleName: "Minor",
  rootNote: 9,
  selectedTrack: null,
  scriptVersion: 2,
  tracks: {},
};

describe("summaryLine", () => {
  it("reads tempo, key, and count", () => {
    expect(summaryLine(BASE, 12)).toBe("12 tracks · 128 BPM · A Minor");
  });

  it("says a track in the singular", () => {
    expect(summaryLine(BASE, 1)).toBe("1 track · 128 BPM · A Minor");
  });

  // Same honest-unknown wording as the digest's SET line. "0 BPM" would be
  // a claim; "tempo unknown" is the truth.
  it("says tempo unknown rather than inventing a number", () => {
    expect(summaryLine({ ...BASE, tempo: null }, 12)).toBe("12 tracks · tempo unknown · A Minor");
  });

  it("says no key set rather than guessing one", () => {
    expect(summaryLine({ ...BASE, scaleName: null }, 12)).toBe("12 tracks · 128 BPM · no key set");
  });

  it("says no key set when the scale name is empty", () => {
    expect(summaryLine({ ...BASE, scaleName: "" }, 12)).toBe("12 tracks · 128 BPM · no key set");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/summaryLine.test.ts 2>&1 | tee /tmp/t9.log`
Expected: FAIL — cannot resolve `./summaryLine`.

- [ ] **Step 3: Extract the function**

Create `src/ui/summaryLine.ts`:

```ts
import { SetState } from "../live/model";
import { keyName } from "../digest/build";

/**
 * Same honest-unknown wording as the digest's SET line: "tempo unknown"
 * rather than "0 BPM", "no key set" rather than a guessed key. Kept in sync
 * by calling keyName directly instead of re-deriving it.
 */
export function summaryLine(state: SetState, trackCount: number): string {
  const tempo = state.tempo === null ? "tempo unknown" : `${state.tempo} BPM`;
  const key = keyName(state.rootNote, state.scaleName) ?? "no key set";
  return `${trackCount} track${trackCount === 1 ? "" : "s"} · ${tempo} · ${key}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/ui/summaryLine.test.ts 2>&1 | tee /tmp/t9.log`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the disclosure**

Create `src/ui/WhatICanSee.css`:

```css
.wics {
  border-top: 1px solid var(--border);
  background: var(--surface-raised);
}

.wics__summary {
  padding: 10px 15px;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--text-muted);
  cursor: pointer;
  list-style: none;
}

.wics__summary::-webkit-details-marker {
  display: none;
}

.wics__panel {
  padding: 0 15px 13px;
  max-height: 220px;
  overflow-y: auto;
}

.wics__line {
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.wics__table {
  width: 100%;
  border-collapse: collapse;
  font: 12px ui-monospace, monospace;
  color: var(--text-secondary);
}

.wics__table th {
  text-align: left;
  font-weight: 400;
  color: var(--text-faint);
  padding-bottom: 4px;
}

.wics__table td {
  padding-right: 10px;
  white-space: nowrap;
}

.wics__row--selected td {
  color: var(--text);
}
```

Create `src/ui/WhatICanSee.tsx`:

```tsx
import { useState } from "react";
import "./WhatICanSee.css";
import { SetState } from "../live/model";
import { summaryLine } from "./summaryLine";
import wireVersion from "../../shared/wire-version.json";

// Same persistence pattern as the goal: survive a webview reload, and never
// let a storage failure take the component down with it.
const EXPANDED_KEY = "copilot.tracksExpanded";

function loadExpanded(): boolean {
  try {
    return localStorage.getItem(EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveExpanded(expanded: boolean): void {
  try {
    localStorage.setItem(EXPANDED_KEY, expanded ? "1" : "0");
  } catch {
    // Best-effort only -- see loadExpanded.
  }
}

/**
 * Everything Live already shows, in the one place it earns its keep.
 *
 * The producer does not need a worse copy of her own track list while she
 * works. She does need to be able to check that this app is really reading
 * her set when an answer looks wrong -- and that is what this is for.
 * Collapsed by default, and it stays that way.
 */
export function WhatICanSee({ state }: { state: SetState }) {
  const [expanded, setExpanded] = useState(loadExpanded);

  const indices = Object.keys(state.tracks)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <details
      className="wics"
      open={expanded}
      onToggle={(e) => {
        const isOpen = e.currentTarget.open;
        setExpanded(isOpen);
        saveExpanded(isOpen);
      }}
    >
      <summary className="wics__summary">What I can see</summary>
      <div className="wics__panel">
        <div className="wics__line">{summaryLine(state, indices.length)}</div>
        <div className="wics__line">
          connector v{state.scriptVersion ?? "—"} · this app expects v{wireVersion.version}
        </div>
        <table className="wics__table">
          <thead>
            <tr>
              <th>#</th>
              <th>name</th>
              {/* The formatted dB string straight from Live's own fader
                  readout, carried by mixer_data. */}
              <th>fader</th>
              <th>m</th>
              <th>s</th>
            </tr>
          </thead>
          <tbody>
            {indices.map((i) => (
              <tr
                key={i}
                className={state.selectedTrack === i ? "wics__row--selected" : undefined}
              >
                <td>{i}</td>
                <td>{state.tracks[i].name ?? "—"}</td>
                <td>{state.tracks[i].volumeDb ?? "—"}</td>
                <td>{state.tracks[i].mute ? "M" : ""}</td>
                <td>{state.tracks[i].solo ? "S" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
```

- [ ] **Step 6: Delete the old view**

```bash
git rm src/ui/SetView.tsx
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run 2>&1 | tee /tmp/t9.log`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/WhatICanSee.tsx src/ui/WhatICanSee.css src/ui/summaryLine.ts src/ui/summaryLine.test.ts
git commit -m "Demote the track table to a What I can see disclosure

She does not need a worse copy of her own track list while she works. She
does need to check the app is really reading her set when an answer looks
wrong, which is the one job this does.

summaryLine had no test; extracting it gave it one, including the two
honest-unknown cases -- tempo unknown rather than 0 BPM, no key set rather
than a guessed key."
```

---

### Task 10: The connection banner and the Advanced pane

`selectBanner` does not change. Its rendering does. And the settings pane becomes the door everything technical goes behind.

**Files:**
- Modify: `src/ui/Connection.tsx` (JSX only — `selectBanner` and every constant above it stay byte-identical)
- Create: `src/ui/Connection.css`
- Create: `src/ui/Advanced.tsx`
- Create: `src/ui/Advanced.css`
- Delete: `src/ui/Settings.tsx`

**Interfaces:**
- Consumes: `selectBanner`, `BannerState`, `ConnectionStatus` from `src/ui/Connection.tsx`; `TraceView` from `src/ui/Trace.tsx`.
- Produces: `<Advanced onClose={() => void} />`.

- [ ] **Step 1: Confirm the banner tests are green before touching anything**

Run: `npx vitest run src/ui/Connection.test.ts 2>&1 | tee /tmp/t10-before.log`
Expected: PASS. Keep this log — it is the baseline the rendering change must not move.

- [ ] **Step 2: Write the banner stylesheet**

Create `src/ui/Connection.css`:

```css
.banner {
  padding: 12px 15px;
  border-bottom: 1px solid var(--border);
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--text-secondary);
}

.banner__label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  margin-bottom: 7px;
}

.banner__dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-pill);
  flex: none;
}

.banner--error .banner__dot {
  background: var(--error);
}

.banner--error .banner__label {
  color: #c78a80;
}

.banner--warn .banner__dot {
  background: var(--accent);
}

.banner--warn .banner__label {
  color: #d3b078;
}

/* The port number, the two version numbers -- available, never leading.
   Nobody reads a port number and works out what to do with it. */
.banner__detail {
  font: 11px ui-monospace, monospace;
  color: var(--text-faint);
  margin-top: 7px;
}
```

- [ ] **Step 3: Replace only the JSX in `Connection.tsx`**

Everything from the top of the file through the closing brace of `selectBanner` stays exactly as it is. Add the stylesheet import at the top, and replace the `switch (banner.kind)` block at the end of the `Connection` component with:

```tsx
  switch (banner.kind) {
    case "none":
      return null;
    case "bind_failed":
      return (
        <div className="banner banner--error">
          <div className="banner__label">
            <span className="banner__dot" />
            Port in use
          </div>
          Something else is already using port {banner.port} — usually a leftover
          script, or a second copy of Mixing Pal. Close it and open Mixing Pal again.
          <div className="banner__detail">{banner.error}</div>
        </div>
      );
    case "not_connected":
      return (
        <div className="banner banner--error">
          <div className="banner__label">
            <span className="banner__dot" />
            Not connected
          </div>
          Open a set in Live, and check that <b>Mixing Pal</b> is selected under
          Preferences → Link, Tempo &amp; MIDI.
        </div>
      );
    case "version_mismatch":
      return (
        <div className="banner banner--warn">
          <div className="banner__label">
            <span className="banner__dot" />
            Connector out of date
          </div>
          Mixing Pal updated, but the part inside Live didn't. Reinstall it and
          restart Live.
          <div className="banner__detail">
            expects v{banner.required}, found v{banner.actual}
          </div>
        </div>
      );
    case "stale_script":
      return (
        <div className="banner banner--warn">
          <div className="banner__label">
            <span className="banner__dot" />
            Connector out of date
          </div>
          Live is sending data, but the connector isn't reporting its version —
          usually a sign it's out of date, and some readings (faders, pan, dB) may
          be missing. Reinstall it and restart Live.
        </div>
      );
  }
```

Add at the top of the file, below the existing imports:

```tsx
import "./Connection.css";
```

The *Show me where* and *Reinstall* actions the spec describes need the setup flow to exist, so they arrive in the first-run plan. The copy here already names the fix.

- [ ] **Step 4: Confirm the banner tests still pass, unchanged**

Run: `npx vitest run src/ui/Connection.test.ts 2>&1 | tee /tmp/t10-after.log && git diff --stat src/ui/Connection.test.ts`
Expected: PASS with the same test count as `/tmp/t10-before.log`, and `git diff` reports **no change** to `Connection.test.ts`. If the test file changed, revert it — the logic was not supposed to move.

- [ ] **Step 5: Write the Advanced pane**

Create `src/ui/Advanced.css`:

```css
.advanced {
  padding: 15px;
  background: var(--surface-raised);
  border-top: 1px solid var(--border);
  font-size: 13px;
  color: var(--text-secondary);
}

.advanced__field {
  display: block;
  margin-bottom: 10px;
}

.advanced__label {
  display: block;
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--text-muted);
  margin-bottom: 4px;
}

.advanced__input {
  width: 100%;
  box-sizing: border-box;
  background: var(--surface-sunken);
  border: 1px solid var(--border);
  border-radius: var(--radius-control);
  padding: 7px 9px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  outline: none;
}

.advanced__input:focus {
  border-color: var(--border-strong);
}

.advanced__note {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-faint);
  margin-bottom: 14px;
}

.advanced__button {
  background: var(--surface-sunken);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-control);
  padding: 7px 12px;
  font: inherit;
  font-size: 13px;
  color: var(--text);
  cursor: pointer;
}

.advanced__error {
  background: rgba(224, 108, 92, 0.1);
  border: 1px solid rgba(224, 108, 92, 0.28);
  border-radius: var(--radius-control);
  padding: 10px 12px;
  margin-top: 10px;
  white-space: pre-wrap;
  font-size: 12px;
}
```

Create `src/ui/Advanced.tsx`. This is `Settings.tsx`'s logic — including the probe-before-persist behaviour and the deliberate never-show-the-key rule — moved behind a door, restyled, with the trace view underneath:

```tsx
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./Advanced.css";
import { Trace } from "./Trace";

interface SettingsView {
  base_url: string;
  model: string;
  has_key: boolean;
}

/**
 * Everything the producer should never need to see.
 *
 * The bring-your-own-key fields live here rather than in setup because
 * they are a pressure valve for a technical minority and for the day the
 * proxy is down -- not a step anybody is asked to complete.
 */
export function Advanced({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    invoke<SettingsView>("get_settings").then(setView).catch(() => setView(null));
  }, []);

  if (view === null) return null;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      // Rust probes before it persists: a model that cannot call tools is
      // refused here, with its own answer quoted back.
      const saved = await invoke<SettingsView>("save_settings", {
        baseUrl: view!.base_url,
        modelName: view!.model,
        // Empty means "keep the stored key" -- this pane never sees it.
        apiKey: key,
      });
      setView(saved);
      setKey("");
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="advanced">
      <div className="advanced__note">
        Mixing Pal normally handles this for you. These fields point it at your own
        provider instead.
      </div>

      <label className="advanced__field">
        <span className="advanced__label">Base URL</span>
        <input
          className="advanced__input"
          value={view.base_url}
          onChange={(e) => setView({ ...view, base_url: e.target.value })}
        />
      </label>

      <label className="advanced__field">
        <span className="advanced__label">Model</span>
        <input
          className="advanced__input"
          placeholder="moonshotai/kimi-k2"
          value={view.model}
          onChange={(e) => setView({ ...view, model: e.target.value })}
        />
      </label>

      <label className="advanced__field">
        <span className="advanced__label">API key</span>
        <input
          className="advanced__input"
          type="password"
          placeholder={view.has_key ? "stored — leave blank to keep" : "required"}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>

      <button className="advanced__button" onClick={save} disabled={saving}>
        {saving ? "Checking the model…" : "Save"}
      </button>
      <button className="advanced__button" onClick={onClose} style={{ marginLeft: 6 }}>
        Cancel
      </button>

      {error !== null && <div className="advanced__error">{error}</div>}

      <Trace />
    </div>
  );
}
```

- [ ] **Step 6: Delete the old settings pane**

```bash
git rm src/ui/Settings.tsx
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run 2>&1 | tee /tmp/t10.log`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ui/Connection.tsx src/ui/Connection.css src/ui/Advanced.tsx src/ui/Advanced.css
git commit -m "Re-dress the connection banner, put settings behind Advanced

selectBanner and its tests are untouched -- the logic was correct, only
the #7a2020 box had to go. Port numbers and version numbers are still
there but no longer lead: nobody reads a port number and works out what
to do with it.

BYOK moves behind a door. It is a pressure valve for a technical minority
and for the day the proxy is down, not a step anyone is asked to complete."
```

---

### Task 11: Assemble the shell

Wire the mode machine to the window, the rule to the nudge slot, and delete what is now dead.

**Files:**
- Modify: `src/App.tsx` (rewritten)

**Interfaces:**
- Consumes: everything from Tasks 1–10.
- Produces: the running app.

- [ ] **Step 1: Rewrite `App.tsx`**

```tsx
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { Delta } from "./live/model";
import { emptySet, applyDelta } from "./live/apply";
import { Card } from "./ui/Card";
import { Pill } from "./ui/Pill";
import { pillState } from "./ui/pillState";
import { MODE_GEOMETRY, ModeEvent, WindowMode, nextMode } from "./ui/windowMode";
import { STALE_MS } from "./ui/Connection";
import { unnamedTracks } from "./rules/unnamedTracks";
import { EMPTY_NUDGE_STATE, dismiss, offer } from "./rules/nudges";

export default function App() {
  const [state, setState] = useState(emptySet());
  const [lastSeen, setLastSeen] = useState<number | null>(null);
  const [mode, setMode] = useState<WindowMode>("card");
  const [nudges, setNudges] = useState(EMPTY_NUDGE_STATE);
  const [turnRunning, setTurnRunning] = useState(false);
  const [unread, setUnread] = useState(false);
  const [inputEmpty, setInputEmpty] = useState(true);

  // The mode machine needs the current context on every event, but the
  // context changes far more often than the mode does. A ref keeps the
  // dispatch callback stable so it does not re-subscribe the blur listener
  // on every keystroke.
  const ctx = useRef({ inputEmpty, turnRunning, unread });
  ctx.current = { inputEmpty, turnRunning, unread };

  const dispatch = useCallback((event: ModeEvent) => {
    setMode((current) => nextMode(current, event, ctx.current));
  }, []);

  useEffect(() => {
    // Rust never resends a subscription's initial value on its own -- it
    // arrives once, at subscribe time, and the emit loop can drain and
    // forward it before this listener even exists. Attach the listener
    // FIRST, then fetch the retained snapshot: nothing can slip through
    // the gap, because applyDelta is last-write-wins, so a delta that
    // arrives mid-fetch and also appears in the snapshot just gets applied
    // twice, harmlessly. Fetching first would risk the opposite.
    const stop = listen<Delta[]>("live://deltas", (event) => {
      setState((prev) => event.payload.reduce(applyDelta, prev));
      setLastSeen(Date.now());
    });

    invoke<Delta[]>("snapshot")
      .then((snapshot) => {
        if (snapshot.length === 0) return;
        setState((prev) => snapshot.reduce(applyDelta, prev));
        setLastSeen(Date.now());
      })
      .catch((err) => {
        console.error("failed to fetch initial snapshot", err);
      });

    return () => {
      stop.then((unlisten) => unlisten());
    };
  }, []);

  // Staleness is the absence of deltas, so no delta will ever arrive to
  // trigger the re-render that notices it. This forces the check.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const connected = lastSeen !== null && Date.now() - lastSeen <= STALE_MS;

  // Rules run against every state change; `offer` is what stops a true
  // observation reappearing every two seconds.
  useEffect(() => {
    setNudges((n) => offer(n, unnamedTracks(state), Date.now()));
  }, [state]);

  const nudge = nudges.current;
  useEffect(() => {
    if (nudge !== null) dispatch({ type: "nudge_arrived" });
  }, [nudge, dispatch]);

  useEffect(() => {
    const onBlur = () => dispatch({ type: "blur" });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dispatch({ type: "escape" });
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
    };
  }, [dispatch]);

  // Resize after the DOM has the new content but before the frame paints,
  // so the window never shows a card at the pill's size or the reverse.
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const geometry = MODE_GEOMETRY[mode];
    const height =
      geometry.height ??
      Math.min(root.current?.scrollHeight ?? 0, geometry.maxHeight ?? Infinity);
    invoke("set_window_mode", { mode, width: geometry.width, height: Math.ceil(height) }).catch(
      (err) => console.error("failed to apply window mode", err),
    );
  });

  return (
    <div ref={root}>
      {mode === "card" ? (
        <Card
          state={state}
          lastSeen={lastSeen}
          connected={connected}
          nudge={nudge}
          onDismissNudge={(id) => setNudges((n) => dismiss(n, id))}
          onTurnRunningChange={setTurnRunning}
          onAnswer={() => {
            setUnread(true);
            dispatch({ type: "answer_completed" });
          }}
          onCollapse={() => dispatch({ type: "chevron_closed" })}
          onInputEmptyChange={setInputEmpty}
        />
      ) : (
        <Pill
          state={pillState({ connected, unread, turnRunning })}
          onClick={() => {
            setUnread(false);
            dispatch({ type: "pill_clicked" });
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Thread `onInputEmptyChange` through the card**

`App.tsx` passes it; `Card.tsx` and `Conversation.tsx` must accept and call it, or the blur rule can never see a half-typed question and will collapse the card out from under her.

In `src/ui/Card.tsx`, add `onInputEmptyChange: (empty: boolean) => void` to the props type and pass it straight to `<Conversation>`.

In `src/ui/Conversation.tsx`, add the same prop and call it wherever `setInput` is called:

```tsx
        <input
          className="card__input"
          value={input}
          placeholder="Ask about the set…"
          onChange={(e) => {
            setInput(e.target.value);
            onInputEmptyChange(e.target.value.trim() === "");
          }}
          onKeyDown={(e) => e.key === "Enter" && send()}
        />
```

and in `send()`, after `setInput("")`:

```tsx
    onInputEmptyChange(true);
```

- [ ] **Step 3: Typecheck and run everything**

Run: `npm run build 2>&1 | tee /tmp/t11.log && npx vitest run 2>&1 | tee -a /tmp/t11.log && cd src-tauri && cargo test 2>&1 | tee -a /tmp/t11.log`
Expected: build succeeds with no unused-import errors, all frontend tests PASS, all Rust tests PASS.

If the build reports `src/ui/Chat.tsx` or `src/ui/SetView.tsx` as missing, the `git rm` steps in Tasks 8 and 9 did not run. Run them.

- [ ] **Step 4: Run it against real Live**

This is the first point where the whole thing exists. `npm run tauri dev` with Live open and the connector selected.

Confirm by looking:
1. The card appears frameless with rounded corners and no system shadow rectangle.
2. Dragging anywhere on the header moves the window.
3. Escape collapses it to a round dot; clicking the dot opens it.
4. Typing half a question and clicking into Live leaves the card open.
5. Typing nothing and clicking into Live collapses it.
6. Asking a question shows `reading <a track name>…`, never JSON.
7. Quitting Live shows the not-connected banner; the collapsed pill reads `not connected` in words.
8. The accent colour appears at most twice in the view. Count it.

- [ ] **Step 5: Record what only a human can check**

Append to `docs/manual-verification.md`:

```markdown
## The shell (added 2026-08-19)

- [ ] The window is frameless and transparent: rounded corners, no square
      grey system shadow behind the pill. If the pill is a black square,
      `macOSPrivateApi` is not set in `tauri.conf.json`.
- [ ] Dragging the card header moves the window. There is no titlebar, so
      if this fails the window cannot be moved at all.
- [ ] Drag the card to a second display, quit, unplug the display, reopen.
      The card must appear on the remaining screen — `clamp_to_visible`
      exists for exactly this, and the failure mode is an invisible window
      with no titlebar to drag back.
- [ ] Escape collapses to the pill; clicking the pill reopens the card.
- [ ] With text typed in the input, clicking into Live leaves the card
      open. With the input empty, it collapses.
- [ ] Ask something that makes the model read a track. The progress line
      names the track, never a function name or JSON.
- [ ] Quit Live. The banner appears, and the collapsed pill grows to read
      "not connected".
- [ ] Count the uses of the accent colour in one view. At most two.
```

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/ui/Card.tsx src/ui/Conversation.tsx docs/manual-verification.md
git commit -m "Assemble the shell

Wires the mode machine to the window, the rule to the nudge slot, and the
pill to the card. Resizing runs in useLayoutEffect so the window never
paints a card at the pill's size.

onInputEmptyChange is threaded from the input up to the mode machine:
without it the blur rule cannot see a half-typed question and collapses
the card out from under her."
```

---

## Self-Review

**Spec coverage.** Principles 1–3: Tasks 8, 9, 10 (chrome carries no tempo/key/track count; prose is the brightest text; only the disconnected pill has words). Form factor and window behaviour: Tasks 1, 2, 3, 11. The card: Task 8. The pill: Task 4. Nudges: Task 7. Advanced: Task 10. Design tokens: Task 2. Code-changes table: Tasks 4–11 cover every row except `Setup/`, which is the first-run plan. Testing section: covered, with the `selectBanner`-untouched requirement enforced by a `git diff` assertion in Task 10 Step 4.

**Deliberately deferred to the first-run plan, not dropped:** the `Show me where` and `Reinstall` actions on the banners (they need the setup flow to exist), and the reader panel (the spec defers it explicitly).

**Placeholder scan.** No TBDs. Every code step carries real code. The one judgement call left open is the `DEFAULT_NAME` regex, which is not a placeholder — it is an implemented pattern with a recorded manual check, because the spec forbids taking Live's default naming from memory.

**Type consistency.** `WindowMode`'s three variants match between `src/ui/windowMode.ts` and `src-tauri/src/window.rs` via `#[serde(rename_all = "snake_case")]`. `Nudge` is defined once in `src/rules/nudges.ts` and imported by `unnamedTracks.ts` and `Noticed.tsx`. `progressLabel(name, args, state)` is called with exactly that signature in `Conversation.tsx`. `onInputEmptyChange` is added to `App` → `Card` → `Conversation` in Task 11 Step 2, which is the one prop introduced after its consumer was written — flagged in the step because a subagent building Task 8 in isolation will not have it.
