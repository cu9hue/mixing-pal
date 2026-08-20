# Product UI — Design

Date: 2026-08-19
Status: approved for planning
Supersedes the UI sections of `2026-08-15-ableton-copilot-design.md`. Everything
else in that document still stands.

## Why this exists

The app works and looks like the test harness it grew out of: inline style
objects, a raw track table, a settings pane that asks for an API key and a model
ID typed from memory, and a Remote Script you install by running a bash script in
a terminal. The person it is being built for should never meet any of that.

The goal is a product she installs and opens. Turning that into work means three
independent subsystems, each with its own spec, plan, and build:

| | Subsystem | Owns |
| --- | --- | --- |
| **A** | Distribution | Product identity, signing, notarization, the `.dmg`, bundling the Remote Script as a resource, auto-update, release CI |
| **B** | Model access | A token-authenticated proxy holding the provider key, per-account metering and caps, invite codes, consented trace capture |
| **C** | Product UI | **This document.** Form factor, first run, the card, the nudge surface, error states, design tokens |

Build order is **C → A → B**. C first because every screen A and B add — install
progress, redeem a code — lands inside C's shell. Building them against today's
inline styles means building them twice.

## Scope

**In:** window behaviour, the card, the pill, first-run onboarding, connection
and failure states, the nudge surface plus one rule, the Advanced pane, design
tokens, and the `install_connector` command that onboarding step 1 calls.

**Out:** the rename sweep itself (A — see The name), signing and notarization (A),
the proxy and real accounts (B), the reader panel (designed here, built after the
card is in use), `off_scale_notes` (blocked on `PollKind::FocusedNotes`, still
unwired at `lib.rs:974`).

## Principles

Three rules. Every decision below traces to one of them.

**1. Say only what Live doesn't.** Tempo, key, track count, and the track table
are all in Live already, shown larger and more accurately. Mirroring them makes
the app a worse copy of a window that is already open. They leave the permanent
chrome entirely. They survive in exactly one place — the "what I can see"
disclosure — where the job is proof that the app is reading the set, not
information the producer needs.

**2. Measured and generated look different.** The app cannot hear the music it
advises on. It reads settings. So facts the app measured are small, dim, and
letterspaced; the model's prose is the largest and lightest text on screen. The
separation is carried by size, weight, and space, in one type family. An earlier
draft carried it with a serif for the model's prose; that was withdrawn — at
14px on a dark background in a 320px panel a serif loses to a good sans on every
measure that matters.

**3. Quiet by default, words only on failure.** Three of the pill's four states
are a dot. It grows into words when the connection breaks, because that is the
one thing Live will never tell her.

## Form factor

A floating card that collapses to a pill. Always on top, frameless, dragged
anywhere. Idle it is a small dot; ask something and it grows to a comfortable
reading width; it settles back when she is done.

Rejected, with reasons:

- **Docked side strip** — takes a fixed slice of screen permanently and forces
  her to resize Live once so they stop overlapping.
- **Menu bar app** — costs zero pixels idle, which is the best possible answer on
  a 13" laptop, but invisible means forgotten and it demotes nudges to system
  notifications, which are trivially ignored.
- **Ordinary window** — simplest to build, but it stops being ambient. It becomes
  a thing you go to rather than a thing that is there, and that removes the
  reason for nudges to exist.

The original design document already specified "always on top, small, frameless".
The code never did it — `tauri.conf.json` still ships a decorated 800×600 window.
This spec is where that gets built rather than assumed.

## Window behaviour

One Tauri window in three modes, resized and repositioned programmatically. Not
three windows: three windows means three lifecycles, three focus behaviours, and
a webview reload that has to reconstruct which one is real.

| Mode | Size | Position | Always-on-top | Transparent |
| --- | --- | --- | --- | --- |
| `setup` | 600 × 680 | centred | off | no |
| `pill` | 44 × 44 | remembered | on | yes |
| `card` | 320 × content, max 520 | remembered | on | yes |

- The pill window is 44×44 so the 26px dot has room for its glow. Transparency is
  required or the glow renders on a black square.
- Card height follows content and clamps at 520. Past that the answer body
  scrolls inside the card; the header, input, and disclaimer never scroll away.
- The whole card is a drag region (`data-tauri-drag-region`) except the input,
  buttons, chevron, and goal text.
- Position is remembered and restored. Store it keyed by the current screen
  layout, so plugging in a monitor does not place the card off-screen. On
  restore, clamp to the visible area of some current monitor.
- Mode transitions: pill → card on click, or automatically when a nudge arrives
  or an answer completes. Card → pill on Escape, on clicking the chevron closed,
  or on losing focus — but only when the input is empty, no turn is running, and
  nothing is unread. Collapsing a card she was halfway through typing into is
  worse than leaving it open.

Never steal focus. A card that appears on top of Live and takes the keyboard mid-
take is worse than no app at all.

## The card

Top to bottom:

```
┌──────────────────────────────────────┐
│ ● │ dark garage, 2am            ⌄   │   header
├──────────────────────────────────────┤
│ ▍ Noticed                            │   nudge slot (only when present)
│ ▍ Seven tracks are still named       │
│ ▍ MIDI or Audio.                     │
├──────────────────────────────────────┤
│ why does the pad feel in the way     │   last question, dim 13px
│                                      │
│ The pad's Auto Filter is fully open  │   the answer, 14 / 1.68
│ at 12 kHz. Its low end runs straight │
│ into ⟨808 Sub⟩. A high-pass near     │
│ 180 Hz separates them.               │
├──────────────────────────────────────┤
│ Ask about the set…                   │   input
│ AI can make mistakes.                │   disclaimer
└──────────────────────────────────────┘
```

**Header.** Status dot, the goal text, a chevron. Nothing else. The goal is the
persistent free-text field the original spec calls "probably the highest leverage"
thing in the design — it cannot be a permanent input box in this chrome, so it
becomes the header's one line of text: dim, click to edit, `maxLength` 500,
persisted as today. It stays visible because it makes answers specific, and it
stays quiet because she wrote it and does not need to read it back.

**Noticed slot.** Present only when a nudge is live. A 2px accent rule on the
left, the label `Noticed` above the sentence. Dismissible; dismissal persists for
the session. Never more than one at a time.

**Answer area.** The current exchange only — reading model 2. The question sits
above the answer in dim 13px so the answer has something to attach to. Previous
turns are not on screen; the model still receives full history.

**Progress.** While a turn is running, one dim line that names the thing, not the
function: `reading Pad Wide…`, not `reading get_track_detail({"index":3})…`. When
the tool's arguments resolve to a track in the mirror, name that track; when they
do not, fall back to a plain verb phrase per tool (`reading the clip…`). Never
render raw arguments. The line is replaced by the answer rather than accumulating
above it. The raw call log already exists as `Trace.tsx` and moves behind
Advanced, which is where a debugger belongs.

**Disclaimer.** `AI can make mistakes. Treat responses as suggestions.` stays
permanent and non-dismissible, per the original spec, as the dimmest text in the
app. This is not negotiable chrome: the app states things fluently, in prose,
about the producer's music, and it cannot hear any of it.

**What I can see.** The chevron opens a disclosure holding the track table,
tempo, key, connection detail, and the Remote Script's wire version. Collapsed by
default, never open while she works. This is where `SetView.tsx`'s table lands,
and its one job is proof that the app really reads the set.

## The pill

| State | Appearance |
| --- | --- |
| Idle, connected | 26px dot, `--surface` fill, `--text-faint` centre |
| Something to read | accent centre, accent-tinted ring, soft glow |
| Thinking | `--text-muted` centre, slow opacity breathe, ~2s cycle |
| Not connected | grows to a pill with an error dot and the words `not connected` |

Only the failure state has words.

## The reader — designed here, built later

"I want to see the thing it said twenty minutes ago" is a real need, and paging
back with arrows is a poor answer to it. The reader is a taller panel listing the
whole session — every question, every answer, every nudge — with the current one
marked.

It is deliberately not in the first build. The card is reading model 2 and that
is the correct permanent state; building the reader second means the card never
grows navigation it will later throw away, and no one carries two layouts before
the first has been used in anger.

## First run

A setup window, because Live's preferences cannot be taught in a 320px card. It
shrinks into the card when setup completes.

### The steps

**1 — Install.** "Mixing Pal needs a small connector inside Live." One button. Copies
the bundled Remote Script into the Ableton User Library. Reassurance underneath:
"Goes to your Ableton User Library. Nothing else on your computer is touched."

**2 — Restart Live.** "Live only looks for connectors when it starts." If Live is
running: "Live is open right now. Quit it and open it again." Detected by polling
`live_is_running`; no button to press. If Live is not running, the step says so
and waits.

**3 — Turn it on.** The step that decides whether she ever gets there.
"In Live: Preferences → Link, Tempo & MIDI", then a **real screenshot** of that
pane with the Control Surface dropdown highlighted — not a drawing, and captured
from a current Live version. One note underneath, because it is the thing people
get wrong: **Input and Output stay None.**

**4 — Connected.** The payoff, and the only place in the product where mirroring
Live earns its keep. A green dot, then proof, then the scope of the promise:

> Connected. I can see **12 tracks** — Kick, 808 Sub, Pad Wide, Vox Chop…
>
> I read your settings — devices, faders, routing, notes. I can't hear your
> audio, so I'll never tell you something sounds muddy. I'll tell you what's set
> to what, and what that usually means.

The first paragraph is proof and it is the moment the setup pays for itself. The
second is not boilerplate and must not be demoted to fine print: the product is
called Mixing Pal, and this is the one screen that scopes what that means before
she forms an expectation the app cannot meet. See The name.

**5 — Account.** Redeem a code. Placed *after* Connected on purpose: she reaches
a working, visible result in three steps, and only then is asked for something
she has to go and find. The alternative — code first, fail fast — makes the app's
opening move a paywall gesture at someone who has not seen anything work. The
accepted cost is that an invalid code leaves her with the Live setup done and
nothing to ask; the setup is permanent either way, so nothing is wasted.

For the first build this step is pre-provisioned and invisible. The screen exists
and is designed; B fills in what it talks to.

**6 — What are you making?** The goal field, prefilled empty, skippable, editable
forever after. Then the window shrinks into the card.

### Resumability

Setup state is **derived, never stored**. On launch the app asks four questions —
is the connector installed and current, is Live running, are deltas arriving, is
there an account — and lands on the first unsatisfied step. A stored step index
would go stale the moment she uninstalls the connector, moves her User Library,
or opens the app on a machine where setup was already done.

### Failure states

The copy in `Connection.tsx` is already good. It is wearing a `#7a2020` box. Same
words, given room, each ending in a control that does the fixable part:

| Condition | Copy | Action |
| --- | --- | --- |
| Port in use | "Something else is already using port 11001 — usually a leftover script, or a second copy of Mixing Pal. Close it and open Mixing Pal again." | — |
| Nothing arriving | "Live is running but nothing is coming through. Check that **Mixing Pal** is still selected under Preferences → Link, Tempo & MIDI." | *Show me where* → reopens step 3 |
| Connector out of date | "Mixing Pal updated, but the part inside Live didn't. Some readings will be missing until you reinstall it." | *Reinstall and restart Live* |

No one reads a port number and works out what to do with it. The technical detail
stays available in the disclosure; it does not lead.

### Not automated, deliberately

Selecting the Control Surface could be done for her by writing Live's
`Preferences.cfg` directly. We do not. It is an undocumented format that changes
between Live versions, and it holds every preference she has ever set — getting
it wrong corrupts all of them. A clear picture of the dropdown is a worse
experience and a much better trade.

## Nudges

The surface is designed and built. One rule ships.

**`unnamed_tracks`** — a pure function over the track mirror that already exists.
No new plumbing, and more importantly it is the one rule that **cannot be wrong**.
A wrong first nudge costs more trust than a missing one; that is the original
spec's position and it decides which rule goes first.

- Predicate: at least 6 tracks carrying a Live default name, in a set of at least
  10 tracks.
- The default-name pattern must be **verified against a real Live 12 set** before
  the rule is trusted — the exact default naming is not something to take from
  memory. Add it to `docs/manual-verification.md`.
- Copy, templated on the count: "Seven tracks are still named MIDI or Audio."
  Spell the number in words up to ten, matching the register of the model's prose
  rather than the register of a linter.
- Global cooldown 10 minutes, per the original spec. Dismissible, dismissal
  persists for the session.

`master_level_high` is second: the meter data is already flowing (`PollKind::Meters`
polls `/live/master/get/output_meter_level` every 2s) but the rule needs windowed
state, so it is a later cycle. `off_scale_notes` — the rule the original spec
calls "the always-on rule that carries a first session" — is blocked until
`PollKind::FocusedNotes` is wired; `lib.rs:974` is an empty arm today.

The nudge surface is built to hold all three. Do not add rules to raise the nudge
rate.

## Advanced

Everything the producer should never see, behind one door reached from the
disclosure:

- Account status and code
- **BYOK trapdoor** — base URL, model, API key. The existing settings pane,
  demoted. It stays because a technical minority will want it and because it is
  the pressure valve if the proxy is down.
- The trace view (`Trace.tsx`, unchanged)
- Connector version, and a reinstall button
- App version

## Design tokens

Direction: **Composed** — its own room rather than Live's chrome. Deeper than
Live's grey so the card reads as a separate object rather than a panel that lost
its window; one warm accent used sparingly; soft depth so it sits *above* Live
instead of being confused with it.

```
--surface            #151619    card, pill
--surface-raised     #1B1D21    disclosure, advanced
--surface-sunken     #101113    inputs
--border             rgba(255,255,255,.07)
--border-strong      rgba(255,255,255,.12)

--text               #E8E9EC    the model's prose
--text-secondary     #C3C7CD    nudge body, measured values
--text-muted         #8B9099    labels
--text-faint         #666C74    placeholders, disclaimer

--accent             #F2B544    nudge rule, primary button, unread dot
--ok                 #5ED6A0    connected
--error              #E06C5C    disconnected, port conflict

--radius-card        12px
--radius-control     8px
--radius-pill        999px
--shadow-card        0 10px 34px rgba(0,0,0,.6)
```

Type — one family, the system UI stack:

| Role | Size / line-height | Treatment |
| --- | --- | --- |
| Model prose | 14 / 1.68 | `--text` |
| Secondary body | 13.5 / 1.6 | `--text-secondary` |
| Last question | 13 / 1.5 | `--text-muted` |
| Label | 11 | uppercase, +0.5px tracking, `--text-muted` |
| Micro | 11 / 1.5 | `--text-faint` |

The accent appears at most twice in any one view. If a third use appears, one of
them is decoration.

### How this is implemented

**CSS custom properties in one `theme.css`, plus colocated component CSS.** Not
Tailwind: this is a Tauri app with no existing utility-class convention, the token
set is small, and custom properties are inspectable in devtools at runtime, which
matters when the surface is a frameless always-on-top window that is awkward to
reason about statically. Inline style objects — today's pattern — cannot carry a
token system and are replaced.

## Code changes

| Today | Becomes |
| --- | --- |
| `App.tsx` | Shell with a window-mode machine (`setup` · `pill` · `card`) |
| `ui/Connection.tsx` | `selectBanner` **survives unchanged** — pure, tested, correct. Only its rendering is replaced |
| `ui/SetView.tsx` | `ui/WhatICanSee.tsx`, a collapsed disclosure |
| `ui/Chat.tsx` | Splits: `ui/Conversation.tsx` (question, answer, progress, input); the goal moves to the header |
| `ui/Settings.tsx` | `ui/Advanced.tsx` |
| `ui/Trace.tsx` | Unchanged, reached from Advanced |
| — | `ui/Setup/` — the step machine and six screens |
| — | `ui/Noticed.tsx` — the nudge slot |
| — | `rules/unnamedTracks.ts` — pure predicate |
| — | `ui/theme.css` — tokens |
| — | `ui/windowMode.ts` — pure mode machine |

New Rust commands:

- `install_connector() -> Result<InstallReport, InstallError>` — copies the
  bundled Remote Script to `~/Music/Ableton/User Library/Remote Scripts/MixingPal`,
  preserving the `logs/` and `__pycache__/` exclusions that
  `scripts/install-remote-script.sh` already gets right. If the User Library is
  not at the default path, return an error variant that asks her to pick the
  folder (needs `tauri-plugin-dialog`).
- `connector_status() -> ConnectorStatus` — installed, and at which wire version.
- `live_is_running() -> bool` — process scan, polled during setup only.
- `set_window_mode(mode)` — size, position, always-on-top, transparency.

The bash installer stays for development. It is no longer how anyone installs.

**Seam with A.** C builds the install command and its UI. A makes the Remote
Script actually present as a bundled resource. Until A lands, `install_connector`
resolves its source from the repo path in dev builds. The command's signature does
not change when A lands — only where it reads from.

## A note for planning

This is one design but probably two plans, split at a clean seam:

1. **The shell** — tokens, window modes, the card, the pill, the disclosure,
   Advanced, the nudge slot and `unnamedTracks`. Ends with a working product for
   someone whose connector is already installed.
2. **First run** — the setup window, the step machine, `install_connector` and
   the other Rust commands, the failure states. Lands inside the shell plan 1
   built.

Plan 1 has no dependency on plan 2. Plan 2 cannot be built first, because every
setup screen is styled by plan 1's tokens and ends by handing off to plan 1's
card.

## Testing

- `selectBanner`'s existing tests carry over untouched. The banner logic is not
  being redesigned, only re-dressed.
- New pure-function tests: `unnamedTracks` predicate (including the boundary at
  6 and at 10 tracks, and the cooldown), the onboarding step derivation (each of
  the four inputs unsatisfied lands on the right step), the window-mode machine.
- `install_connector` gets Rust tests over a scratch directory: fresh install,
  reinstall over an existing copy, `logs/` preserved, missing User Library
  returns the pick-a-folder error rather than creating one.
- `docs/manual-verification.md` gains a first-run section — installing from a
  clean machine, the Live restart detection, the Control Surface step, and the
  connected sentence naming real tracks. None of it can be driven by an agent.
- The default-name pattern for `unnamed_tracks` is verified against a real Live
  12 set before the rule is trusted.

## The name

**Mixing Pal.** Settled 2026-08-19. It clears both trademarks the placeholder did
not: "Ableton" belongs to Ableton AG and is usable only as a descriptor ("for
Ableton Live"), and "Copilot" is Microsoft's in a software context. A search of
music-software and plugin names found nothing using it.

### The promise the name makes

Mixing Pal names one of the three things the product does, and it is the one the
product is most constrained on. It cannot hear. `SYSTEM_PROMPT` forbids it from
claiming anything about how a set sounds — masking, loudness, tone, timbre — and
that constraint is load-bearing, not a limitation to be grown out of. A producer
who downloads something called Mixing Pal reasonably expects it to listen.

This is a copy problem, not a naming problem, and it is solved in exactly one
place: **step 4 of first run**. The connected screen must say what it reads and
what it cannot hear, plainly, before she ever asks a question:

> Connected. I can see **12 tracks** — Kick, 808 Sub, Pad Wide, Vox Chop…
>
> I read your settings — devices, faders, routing, notes. I can't hear your
> audio, so I'll never tell you something sounds muddy. I'll tell you what's set
> to what, and what that usually means.

Get that right and the name costs nothing. Leave it out and every first session
opens with a small disappointment, which is the most expensive kind.

### The rename

The name is not one string. The Remote Script's **folder name is the entry that
appears in Live's Control Surface dropdown**, so this touches:

| Today | Becomes |
| --- | --- |
| `remote-script/AbletonCopilot/` | `remote-script/MixingPal/` |
| `/live/copilot/*` OSC namespace | `/live/mixingpal/*` |
| `com.abletoncopilot.app` | `com.mixingpal.app` |
| `productName: ableton-copilot` | `Mixing Pal` |
| Cargo `name = "ableton-copilot"`, `description = "A Tauri App"`, `authors = ["you"]` | real values |
| `scripts/install-remote-script.sh` destination | `…/Remote Scripts/MixingPal` |
| `remote-script/AbletonCopilot/copilot/` | `remote-script/MixingPal/mixingpal/` |

The OSC namespace rename must move in lockstep with `shared/wire-version.json`,
`shared/handled-addresses.json`, and the version handshake in `Connection.tsx` —
an app on the new namespace talking to an installed script on the old one is
exactly the silent-failure class that handshake was built to catch.

**This rename belongs to A, not to C.** It is mechanical, it touches Rust,
Python, TypeScript, and shell in one sweep, and doing it inside a UI plan would
bury it. C uses the new name in all user-facing copy; A performs the rename.

## Open questions

None blocking. The two carried items are verification tasks, not decisions: the
Live 12 default track-naming pattern for `unnamed_tracks`, and a current
screenshot of the Control Surface pane for first-run step 3.
