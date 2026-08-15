# Ableton Copilot — Design

Date: 2026-08-15
Status: approved for planning (revised after external review)

## Goal

An assistant that watches an Ableton Live session and gives the producer
guidance while they work. It reads the live set continuously, answers questions
on demand, and interjects rarely when a local rule detects something worth
saying.

Three kinds of guidance:

1. **Musical and arrangement feedback** — harmony, structure, repetition, where
   the arrangement is thin.
2. **Mixing critique from settings** — device chains, filter overlap between
   tracks, compressor and EQ settings, chain order, send structure, gain
   structure. It judges **settings, not sound**. It cannot hear masking,
   loudness, tone, or timbre, and the system prompt forbids claiming otherwise.
3. **Workflow and Live technique** — faster ways to do what the producer is
   doing.

## Non-goals for the MVP

- **No write access.** The copilot advises; the producer acts. AbletonOSC
  exposes `set/` endpoints, so writes can be added later behind a confirmation
  step.
- **No audio analysis.** No spectrum, no loudness, no per-track audio content.
  Nothing about how the set actually *sounds*.
- **No screen capture.** Third-party plugin UIs stay invisible.
- **No deep music theory engine.** No functional harmony, no voice leading.
- **No dB values.** See "Volume is not dB" below.

Audio and screen senses are deliberate follow-ups. Ship state-only first and
find out whether the advice is good before paying for more senses.

## Why AbletonOSC

The producer runs **Live 12.2.5 Suite** on macOS.

Ableton's official [Extensions SDK](https://www.ableton.com/en/live/extensions)
is rejected for the MVP. It requires the Live 12.4.5 beta, and an extension
"runs once, performs its task, then stops" — it cannot hold a persistent
process, so it cannot support nudges. Revisit when Extensions ship stable and
gain a background mode.

[AbletonOSC](https://github.com/ideoforms/AbletonOSC) is a Python Remote Script
that exposes the Live Object Model over OSC. It supports Live 11+, is actively
maintained, and covers what remains in scope.

A custom Remote Script (our own Python inside Live, computing the digest in
process) is the upgrade path if OSC round-trip volume becomes the bottleneck.
It is not the starting point: debugging inside Live's Python sandbox is slow.

### Endpoints the design depends on

| Need | Endpoint | Access |
| --- | --- | --- |
| Bulk snapshot of tracks and clips | `/live/song/get/track_data` | query, chunked |
| Tempo, time signature, transport | `/live/song/get/{tempo,signature_numerator,signature_denominator,is_playing,current_song_time}` | listen |
| Key and scale | `/live/song/get/{root_note,scale_name}` | listen |
| Loop brace | `/live/song/get/{loop,loop_start,loop_length}` | listen |
| Track state | `/live/track/get/{name,volume,panning,mute,solo,is_foldable,is_grouped}` | listen, per index |
| Arrangement structure | `/live/track/get/arrangement_clips/{name,length,start_time}` | query |
| Session clips | `/live/track/get/clips/{name,length}` | query |
| MIDI notes | `/live/clip/get/notes` | **query only — poll and diff** |
| Device chain | `/live/device/get/{name,class_name,num_parameters}` | query |
| Device settings, human readable | `/live/device/get/parameter/value_string` | query |
| Device parameter changes | `/live/device/start_listen/parameter/value <track> <device> <param>` | listen, per parameter |
| Levels | `/live/track/get/output_meter_level` | poll, restricted set |
| Selected track / scene | `/live/view/{get,start_listen}/selected_{track,scene}` | listen |
| Selected clip / device | `/live/view/get/selected_{clip,device}` | **query only — poll** |

AbletonOSC listens on UDP port 11000 and replies on 11001.

## OSC protocol realities

These four constraints shape the whole design. Each was verified against the
AbletonOSC endpoint documentation.

### Listener replies alias query replies

A subscription update and a query response arrive at the **same address**. A
listener on track 3's volume replies to `/live/track/get/volume 3 <value>` —
byte-identical in shape to the reply for an explicit query of track 3's volume.
There is no request ID.

The resolution: **treat every inbound packet as a state observation first.**
Every message updates the mirror unconditionally. A separate request table
resolves pending promises:

- One in-flight request per `(address, index-args)` key. A duplicate request
  attaches to the existing promise instead of sending a second packet.
- A pending entry resolves on the first matching inbound message, then clears.
- An inbound message with no pending entry is a listener update. Mirror only.

This degrades safely. If a listener update resolves a query early, the value is
still truthful — same property, same object, current value. Only the causation
is ambiguous, and nothing depends on causation. When the real reply arrives it
finds no pending entry and is absorbed as an observation.

Every request still carries a timeout for the case where AbletonOSC never
answers at all.

### Track indices are not stable identities

Every track, clip, and device subscription is keyed by track index. Live
reindexes on track add, delete, and reorder, silently pointing every
subscription at the wrong track.

The resolution: a **topology watcher**. Poll `/live/song/get/num_tracks` and
`/live/song/get/track_names` every 2 seconds — one cheap bulk call. Any change
in count or ordering is a topology event: tear down all index-keyed
subscriptions, resnapshot, and rebuild. Two same-named tracks swapping position
escapes detection; that is an accepted MVP limitation.

### Note edits are not observable

Clips expose exactly one listener, `playing_position`. There is no note-change
event.

The resolution: poll `/live/clip/get/notes` for the **focused MIDI clip only**,
every 1.5 seconds, and diff against the previous result. Report it as what it
is — "the focused clip's notes changed" — never as "the producer edited notes."
Nothing else in the set gets note polling.

Selected clip and selected device have no listeners either, so both are polled
at 1 Hz. Two messages per second.

### Volume is not dB

`/live/track/get/volume` returns Live's normalized fader position, a float from
0.0 to 1.0, where roughly 0.85 is unity gain. It is not decibels, and Live's
fader curve is nonlinear. The mixer volume is not a device parameter, so
`value_string` cannot supply a formatted value either.

The MVP displays normalized values and labels them as such. Deriving true dB
needs a calibrated fader curve — a follow-up, not a guess. No rule may threshold
on a dB value.

## Architecture

```
Ableton Live 12.2.5 Suite
  └─ AbletonOSC  (Remote Script, selected as a Control Surface)
        │  UDP 11000 out / 11001 in
        ▼
  Tauri v2 desktop app  (always on top, small, frameless)
    ┌─ Rust — the protocol layer ────────────────────────────┐
    │  socket.rs    UDP, OSC codec                           │
    │  requests.rs  single-flight table, timeouts            │
    │  subs.rs      subscription registry, survives reloads  │
    │  topology.rs  index churn detection, teardown/rebuild  │
    │  pollers.rs   focused clip notes, selection, meters    │
    │  deltas.rs    coalesce observations → state deltas     │
    │  model.rs     HTTPS to provider; holds the API key     │
    └────────────────────────────────────────────────────────┘
                    │  coalesced deltas, not raw packets
    ┌─ TypeScript (webview) — the domain layer ──────────────┐
    │  live/     set model, applies deltas, change log       │
    │  digest/   state → structured brief; music analysis    │
    │  rules/    pure nudge predicates                       │
    │  model/    provider interface + adapter                │
    │  agent/    conversation and tool loop                  │
    │  ui/       chat pane, nudge feed                       │
    └────────────────────────────────────────────────────────┘
```

The split follows a single rule: **Rust owns anything whose correctness depends
on not being interrupted or reloaded.** Sockets, in-flight requests,
subscriptions, and topology all qualify. A webview reload must not orphan a
subscription inside Live.

Everything above that line is domain logic we expect to iterate on hard —
musical analysis, digest wording, rule thresholds, prompts. It stays in
TypeScript, where that iteration is cheap. A reload costs a resnapshot and
nothing more, because the subscriptions live in Rust.

Rust never sends raw packets to the webview. It coalesces observations into
deltas on a tick, so a meter stream or a burst of listener updates does not
become thousands of IPC messages.

## Components

### Rust

**`socket.rs`** — Binds UDP, sends to 127.0.0.1:11000, listens on 11001, encodes
and decodes with the `rosc` crate. No protocol knowledge beyond OSC.

**`requests.rs`** — The single-flight request table described above. Exposes
`osc_query(address, args) -> Result<Vec<OscValue>>` with a timeout.

**`subs.rs`** — Owns every `start_listen` registration and can enumerate,
tear down, and rebuild them. Re-registers on reconnect.

**`topology.rs`** — The 2-second track-count and name poll, and the teardown
and rebuild it triggers.

**`pollers.rs`** — Three timers: focused-clip notes at 1.5s, selected clip and
device at 1s, meters at 2s for a restricted track set (see below).

**`deltas.rs`** — Buffers observations and emits a coalesced delta to the
webview every 250 ms.

**`model.rs`** — `model_complete(request)`. Forwards to the configured provider
over HTTPS. The API key is read from the settings store and never crosses into
the webview. The system prompt and the allowed tool schema are backend-owned so
the webview cannot widen them.

### TypeScript

**`live/`** — The set model: song, tracks, clips, devices, selection. Applies
deltas. Holds a ring buffer of recent observations, each stamped with what was
actually observed rather than an inferred cause.

**`digest/music.ts`** — Light analysis of a note list. Pitch range, note count,
rhythmic grid, scale degrees relative to the set's key, velocity spread.
Deterministic and pure. No chord naming, no functional harmony.

**`digest/build.ts`** — Renders the model's view of the set. See below.

**`rules/`** — One pure predicate per rule, taking a snapshot and the
observation log, returning a nudge or nothing.

**`model/provider.ts`** — The interface:

```ts
interface ModelProvider {
  complete(req: {
    system: string
    messages: Message[]
    tools: ToolDef[]
  }): Promise<{ text: string; toolCalls: ToolCall[] }>
}
```

The MVP implements **one** adapter properly, behind provider contract tests that
exercise multi-turn tool calling. A second adapter follows once the contract
tests exist to hold it honest. "OpenAI-compatible by base URL" is not true in
practice for tool calls, so it is not treated as free.

**`agent/loop.ts`** — Builds the digest, calls the provider, executes tool
calls, loops until the model returns text.

## The digest

Two parts. A **structured JSON payload** carries the facts, so nothing is lost to
prose formatting. A **short text summary** orients the model:

```
SET  128 BPM · 4/4 · C minor · 96 bars · Arrangement view
FOCUS  tr3 "Bass" › clip "Bass A" (bars 17-25) › EQ Eight · playing, bar 21
OBSERVED, LAST 60s  Bass A note content changed ×6 · EQ Eight "Frequency 1" moved

TRACKS
 1 Kick   aud fader 0.85  [Drum Rack › Saturator]               4 clips
 2 Bass   mid fader 0.72  [Operator › EQ Eight(HP 80Hz) › Comp]  3 clips
 M Master     fader 0.90  [Limiter]

ARRANGEMENT   1----8---16---24---32---40---48
 Kick         ....████████████████........
 Bass         ........████████████........
 sections: intro 1-16 · A 17-32 · nothing past 48

MIDI  Bass A (8 bars, 32 notes): C1-G2, root C, mostly 1/8, degrees 1 b3 5 b7
```

Faders are normalized, labelled `fader`, never `dB`. The observation line states
what was observed, not what the producer intended.

Included by default, because they are what the producer is working on: the
focused clip's **raw notes**, and the selected device's **full parameter list
with `value_string`**. Everything else is summarized, with drill-down tools for
the rest.

Sections are a heuristic, not a claim about intent. A boundary is marked where
the set of tracks holding a clip changes, quantised to the nearest 8 bars.
Sections are labelled by position (`intro`, then `A`, `B`, …), never by genre
function.

Large sets are capped: the focused track and its neighbours in full, the rest
summarized, and the digest says it truncated.

### Tools

Tools are **live queries against Live**, not mirror reads. The mirror
deliberately does not hold notes or device parameters for the whole set, so a
mirror read would return stale or absent data.

| Tool | Returns |
| --- | --- |
| `get_clip_notes(track, clip)` | Raw note list |
| `get_device_params(track, device)` | Every parameter name and `value_string` |
| `get_track_detail(track)` | Full state for one track |
| `get_arrangement()` | Every arrangement clip with start and length |

Every tool result carries `queried_at`, `fresh`, and `missing_reason`, so the
model can tell the difference between "this is zero" and "Live did not answer."

## Nudges

Deterministic predicates run over the state stream. No model call happens until
one trips. When one does, the rule and the digest go to the model, which writes
a single sentence.

| Rule | Trigger |
| --- | --- |
| `master_level_high` | Master output meter sustained near 1.0 over a window |
| `unnamed_tracks` | Six or more default-named tracks in a set that has grown past a threshold |
| `loop_fatigue` | Same loop brace playing over 8 minutes with no arrangement growth — **opt-in, off by default** |

Cut after review, with reasons:

- `gain_staging` — thresholded on a dB value that does not exist, and a fader
  above unity is not wrong anyway.
- `flat_velocity` — identical velocities are deliberate in most electronic
  music.
- `arrangement_stall` — punishes sound-design and session-view sessions.
- `untouched_device` — needs a per-device default table to mean anything, and
  still is not musically meaningful.

Global cooldown of 10 minutes. Per-rule disable, not only a global mute. Every
nudge is dismissible.

`master_level_high` is named for what it measures. `output_meter_level` is a
0–1 level, not a peak meter, so the rule may not claim clipping.

## Meter polling

Meters are the highest-rate data in the system and the easiest way to bog down
Live's Python thread. The MVP polls `output_meter_level` at 2-second intervals
for **master, plus any focused, armed, or soloed track** — never the whole set,
and never as a subscription.

Before this is considered settled, benchmark at 20, 50, and 100 tracks.

## Error handling

- **Live closed, or AbletonOSC not selected as a Control Surface.** A "not
  connected" banner, reconnect with backoff, subscriptions rebuilt on reconnect.
  Never a hang.
- **Dropped UDP replies.** Per-request timeouts mark the affected slice stale.
  The digest renders what it has and names what is missing.
- **Oversized replies.** `track_data` is chunked by track range, 8 tracks per
  call, to stay well inside practical UDP datagram limits.
- **Provider errors.** Surfaced as text in the chat. The app keeps running.

## Testing

**Automated.** Record real OSC traffic from an actual Live set into fixtures,
then replay against the real code. Tests call real code; no business logic is
reimplemented in a test.

- `requests.rs` — replay interleaved listener updates and query replies on the
  same address, assert correct resolution and no cross-talk.
- `topology.rs` — synthetic add, delete, and reorder events; assert every stale
  subscription is torn down.
- `digest/music.ts` — pure functions over note lists.
- `digest/build.ts` — snapshot tests over fixture states.
- `rules/` — pure predicates over crafted snapshots, both directions.
- `model/` — provider contract tests covering multi-turn tool calling.
- `agent/loop.ts` — a stub provider returning scripted tool calls; assert the
  loop executes them and terminates.

**Manual, against real Live.** Fixture replay cannot catch listener lifecycle
bugs, index churn, UDP loss, or Live UI-thread stalls. A checklist run before
each release:

1. Connect, resnapshot, confirm the digest matches the set.
2. Add, delete, and reorder tracks; confirm no subscription points at the wrong
   track.
3. Change the selected track, clip, and device; confirm focus tracks it.
4. Edit notes in the focused MIDI clip; confirm the diff appears.
5. Load a 50-plus track set; measure digest build time and Live's responsiveness.
6. Restart AbletonOSC mid-session; confirm reconnect and subscription rebuild.
7. Reload the webview; confirm no orphaned subscriptions survive in Live.

## Setup the producer performs once

1. Download AbletonOSC, rename the folder to `AbletonOSC`, and copy it to
   `~/Music/Ableton/User Library/Remote Scripts/`.
2. Restart Live.
3. Preferences → Link/Tempo/MIDI → Control Surface → AbletonOSC.
4. Launch the copilot and set a model provider and key.

## Risks

- **Nudge quality.** A wrong or obvious nudge is worse than silence. Three rules
  ship, all conservative, all individually disableable.
- **Third-party plugin parameters.** VST and AU parameters may return opaque
  names and normalised values. `value_string` helps but is not guaranteed. Stock
  Live devices are the reliable case.
- **Advice quality without audio.** The narrowed mixing scope is honest, but it
  remains to be seen whether settings-only critique is useful enough to justify
  the app. This is the MVP's central bet, and the reason to ship it small.
- **OSC round-trip volume.** Mitigated by chunked bulk queries, restricted meter
  polling, and lazy tool-driven detail. If it still bites, move to a custom
  Remote Script.
- **AbletonOSC is beta.** Well used and actively maintained, but a third-party
  dependency inside Live.
