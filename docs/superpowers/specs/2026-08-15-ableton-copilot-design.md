# Ableton Copilot — Design

Date: 2026-08-15
Status: approved for planning

## Goal

An assistant that watches an Ableton Live session and gives the producer
guidance while they work. It reads the live set continuously, answers questions
on demand, and interjects rarely when a local rule detects something worth
saying.

Three kinds of guidance, all in scope:

1. **Musical and arrangement feedback** — harmony, structure, repetition, where
   the arrangement is thin.
2. **Mixing and sound design** — device settings, gain staging, levels.
3. **Workflow and Live technique** — faster ways to do what the producer is
   doing.

## Non-goals for the MVP

- **No write access.** The copilot advises; the producer acts. AbletonOSC
  exposes `set/` endpoints, so writes can be added later behind a confirmation
  step.
- **No audio analysis.** No spectrum, no loudness, no per-track audio content.
  Track output meters are the only signal about level.
- **No screen capture.** Third-party plugin UIs stay invisible.
- **No deep music theory engine.** No functional harmony, no voice leading.
- **One provider-agnostic model interface**, not a model of our own.

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
maintained, and covers everything the three feedback types need.

A custom Remote Script (our own Python inside Live, computing the digest in
process) is the upgrade path if OSC round-trip volume becomes the bottleneck.
It is not the starting point: debugging inside Live's Python sandbox is slow.

### Endpoints the design depends on

| Need | Endpoint |
| --- | --- |
| Bulk snapshot of tracks and clips | `/live/song/get/track_data` |
| Tempo, time signature, transport | `/live/song/get/{tempo,signature_numerator,signature_denominator,is_playing,current_song_time}` |
| Key and scale | `/live/song/get/{root_note,scale_name}` |
| Loop brace | `/live/song/get/{loop,loop_start,loop_length}` |
| Track state | `/live/track/get/{name,volume,panning,mute,solo,color,is_foldable,is_grouped}` |
| Arrangement structure | `/live/track/get/arrangement_clips/{name,length,start_time}` |
| Session clips | `/live/track/get/clips/{name,length}` |
| MIDI notes | `/live/clip/get/notes` |
| Device chain | `/live/device/get/{name,class_name,num_parameters}` |
| Device settings, human readable | `/live/device/get/parameter/value_string` (returns e.g. `"2500 Hz"`) |
| Levels | `/live/track/get/output_meter_level` |
| Producer focus | `/live/view/get/selected_{track,scene,clip,device}` |
| Change notification | `/live/{song,track,view}/start_listen/<property>` |

AbletonOSC listens on UDP port 11000 and replies on 11001.

## Architecture

```
Ableton Live 12.2.5 Suite
  └─ AbletonOSC  (Remote Script, selected as a Control Surface)
        │  UDP 11000 out / 11001 in
        ▼
  Tauri v2 desktop app  (always on top, small, frameless)
    ┌─ Rust ────────────────────────────────────────────────┐
    │  osc.rs     UDP socket, OSC codec, inbound → events    │
    │  model.rs   HTTP to the model provider; holds the key  │
    │  main.rs    window config, settings store              │
    └────────────────────────────────────────────────────────┘
    ┌─ TypeScript (webview) ─────────────────────────────────┐
    │  live/      set mirror, snapshot, change log           │
    │  digest/    state → brief; light music analysis        │
    │  rules/     pure nudge predicates                      │
    │  model/     provider interface + adapters              │
    │  agent/     conversation and tool loop                 │
    │  ui/        chat pane, nudge feed                      │
    └────────────────────────────────────────────────────────┘
```

Rust is deliberately thin — around 300 lines. It owns the two things the webview
cannot do safely: raw UDP, and holding an API key outside the web context. Every
part we expect to iterate on lives in TypeScript.

The webview may reload during development and lose its state. That is
acceptable: all state derives from Live, so the mirror re-snapshots on load.

## Components

### Rust

**`osc.rs`** — Binds a UDP socket, sends OSC messages to 127.0.0.1:11000 and
listens on 11001. Uses the `rosc` crate for encoding and decoding. Exposes a
`osc_send(address, args)` Tauri command. Emits every inbound message to the
webview as a Tauri event. It holds no protocol knowledge beyond OSC itself.

**`model.rs`** — Exposes `model_complete(request)`. Forwards to the configured
provider over HTTPS and returns the response. The API key is read from the
settings store and never crosses into the webview.

**`main.rs`** — Window: `always_on_top: true`, `skip_taskbar: true`, small
default size, resizable. Settings persisted with `tauri-plugin-store` in the app
data directory.

### TypeScript

**`live/mirror.ts`** — The set state object: song, tracks, clips, devices, view
selection. UDP is fire-and-forget, so requests are correlated by address plus
leading arguments, each with a timeout. A timed-out request marks that slice
stale rather than blocking.

**`live/snapshot.ts`** — Full sync on connect, using `track_data` for bulk
properties and targeted queries for the rest.

**`live/watch.ts`** — Registers `start_listen` subscriptions for song transport,
view selection, and per-track properties. Maintains a ring buffer of recent
changes — the source of the digest's "LAST 60s" line.

**`digest/music.ts`** — Light analysis of a note list. Pitch range, note count,
rhythmic grid (the dominant subdivision), scale degrees relative to the set's
key, velocity spread. Deterministic, pure, no chord naming or functional
harmony.

**`digest/build.ts`** — Renders the mirror into the brief below. Targets roughly
3k tokens. Large sets are capped: the focused track and its neighbours in full,
the rest summarised.

**`rules/`** — One pure predicate per rule, each taking a state snapshot and the
change log and returning a nudge or nothing.

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

Two adapters: `anthropic.ts` and `openai-compatible.ts`. The second covers
OpenAI, OpenRouter, LM Studio, and Ollama's `/v1` endpoint by base URL alone.
Provider and key are settings, not code.

**`agent/loop.ts`** — Builds the digest, calls the provider, executes any tool
calls against the mirror, and loops until the model returns text. Tools:

| Tool | Returns |
| --- | --- |
| `get_clip_notes(track, clip)` | Raw note list for one clip |
| `get_device_params(track, device)` | Every parameter name and `value_string` |
| `get_track_detail(track)` | Full state for one track |
| `get_arrangement()` | Every arrangement clip with start and length |

Detail costs tokens only when the model asks for it.

**`ui/`** — A chat pane and a nudge feed. A mute toggle for nudges. A connection
banner.

## The digest

Rebuilt per turn. Derived features, not raw data.

```
SET  128 BPM · 4/4 · C minor · 96 bars · Arrangement view
FOCUS  tr3 "Bass" › clip "Bass A" (bars 17-25) › EQ Eight · playing, bar 21
LAST 60s  edited Bass A notes ×6, moved EQ Eight Freq 1

TRACKS
 1 Kick   aud -3.0dB  [Drum Rack › Saturator]               4 clips
 2 Bass   mid -6.5dB  [Operator › EQ Eight(HP 80Hz) › Comp]  3 clips
 M Master     -0.5dB  [Limiter]

ARRANGEMENT   1----8---16---24---32---40---48
 Kick         ....████████████████........
 Bass         ........████████████........
 sections: intro 1-16 · A 17-32 · nothing past 48

MIDI  Bass A (8 bars, 32 notes): C1-G2, root C, mostly 1/8, degrees 1 b3 5 b7
```

Sections are a heuristic, not a claim about the producer's intent. A boundary is
marked where the set of tracks holding a clip changes, quantised to the nearest
8 bars. The digest labels sections by position (`intro`, then `A`, `B`, …), not
by genre function.

## Nudges

Deterministic predicates run over the state stream on every change. No model
call happens until one trips. When one does, the rule and the digest go to the
model, which writes a single sentence.

| Rule | Trigger |
| --- | --- |
| `loop_fatigue` | Same loop brace playing over 8 minutes with fewer than 3 edits |
| `clipping` | Master output meter pinned near 1.0 |
| `gain_staging` | Any track fader above +3 dB |
| `arrangement_stall` | 30 minutes in, arrangement still under 32 bars |
| `flat_velocity` | Every note in a clip at identical velocity |
| `untouched_device` | A device at stock defaults for 10 minutes |
| `unnamed_tracks` | Six or more tracks still at default names |

Global cooldown of 10 minutes between nudges. Each nudge is dismissible. A mute
toggle silences all of them.

`flat_velocity` and `untouched_device` need data the mirror does not hold
continuously — clip notes and device parameter values. Neither justifies polling
the whole set. Both evaluate only against the focused track and any clip the
producer edited in the last few minutes, using data already fetched for the
digest.

## Error handling

- **Live closed, or AbletonOSC not selected as a Control Surface.** A "not
  connected" banner, reconnect with backoff. Never a hang.
- **Dropped UDP replies.** Per-request timeouts mark the affected slice stale.
  The digest renders what it has and says what is missing.
- **Oversized sets.** The digest caps track and clip counts, and says it
  truncated.
- **Provider errors.** Surfaced as text in the chat. The app keeps running.

## Testing

Record real OSC traffic from an actual Live set into fixture files, then replay
it against the real mirror and the real digest builder. Tests call the real
code; no business logic is reimplemented in a test.

- `live/` — replay fixtures, assert the mirror matches the set.
- `digest/music.ts` — pure functions over note lists.
- `digest/build.ts` — snapshot tests over fixture states.
- `rules/` — pure predicates over crafted snapshots, both directions.
- `agent/loop.ts` — a stub provider that returns scripted tool calls, asserting
  the loop executes them against the mirror and terminates.

## Setup the producer performs once

1. Download AbletonOSC, rename the folder to `AbletonOSC`, and copy it to
   `~/Music/Ableton/User Library/Remote Scripts/`.
2. Restart Live.
3. Preferences → Link/Tempo/MIDI → Control Surface → AbletonOSC.
4. Launch the copilot and set a model provider and key.

## Risks

- **OSC round-trip volume.** A large set needs many queries. Mitigated by
  `track_data` bulk queries and by fetching device parameters lazily through
  tools. If it still bites, move to a custom Remote Script.
- **Third-party plugin parameters.** VST and AU parameters may return opaque
  names and normalised values. `value_string` helps but is not guaranteed.
  Stock Live devices are the reliable case.
- **Nudge quality.** A wrong or obvious nudge is worse than silence. Rules ship
  conservative, and every nudge is dismissible so the thresholds can be tuned
  against real use.
- **AbletonOSC is beta.** It is well used and actively maintained, but it is a
  third-party dependency inside Live.
