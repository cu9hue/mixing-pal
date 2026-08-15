# Ableton Copilot — Design

Date: 2026-08-15
Status: approved for planning (revised after two adversarial review rounds)

## Goal

An assistant that watches an Ableton Live session and gives the producer
guidance while they work. It reads the live set continuously, answers questions
on demand, and interjects rarely when a local rule detects something worth
saying.

Three kinds of guidance:

1. **Musical and arrangement feedback** — harmony, structure, repetition, where
   the arrangement is thin.
2. **Mixing critique from settings** — device chains, filter overlap between
   tracks, compressor and EQ settings, sidechain routing, chain order, send
   structure, gain structure. It judges **settings, not sound**. It cannot hear
   masking, loudness, tone, or timbre, and the system prompt forbids claiming
   otherwise.
3. **Workflow and Live technique** — faster ways to do what the producer is
   doing.

## Non-goals for the MVP

- **No write access.** The copilot advises; the producer acts. Writes can be
  added later behind a confirmation step.
- **No audio analysis.** No spectrum, no loudness, no per-track audio content.
  Nothing about how the set actually *sounds*. Master metering gives level only.
- **No screen capture.** Third-party plugin UIs stay invisible.
- **No deep music theory engine.** No functional harmony, no voice leading.
- **No streaming responses.** Deferred by decision; see "Response latency".

## The dependency: a vendored fork of AbletonOSC

Ableton's official [Extensions SDK](https://www.ableton.com/en/live/extensions)
is rejected for the MVP. It requires Live 12.4.5 beta (the producer runs
12.2.5), and an extension "runs once, performs its task, then stops" — it cannot
hold a persistent process, so it cannot support nudges. Revisit when Extensions
ship stable and gain a background mode.

[AbletonOSC](https://github.com/ideoforms/AbletonOSC) is the foundation, but
**the project vendors a pinned fork and ships it with the installer.** It is not
an upstream download the producer fetches themselves. Four findings force this,
each verified against upstream source at `master`:

| Gap | Evidence | Fork change |
| --- | --- | --- |
| Master and return tracks unreachable | `track.py:21` resolves `self.song.tracks[i]`; the LOM's `song.tracks` excludes master and returns. The string `master` does not occur anywhere in the source. | Add a handler over `song.master_track` and `song.return_tracks`, same pattern as tracks |
| `track_data` cannot fetch faders | `song.py:141` does `getattr(track, prop)`; `volume` and `panning` live on `track.mixer_device`, not on `Track` | Map `track.volume` / `track.panning` through `mixer_device` |
| No dB anywhere | AbletonOSC never exposes `mixer_device`. In the LOM, `track.mixer_device.volume` *is* a `DeviceParameter` and yields a formatted dB string | Expose the volume parameter's formatted value |
| Dense clips fail hard | See "Datagram budget" below | Notes already have a ranged query form; add the matching ranged form for device parameter queries, which have none |

Vendoring also collapses the old "custom Remote Script" upgrade path into a
gradient: the fork *is* the first step. If OSC round-trip volume ever becomes
the bottleneck, digest computation moves into the fork incrementally rather than
as a rewrite.

The fork is pinned by commit, tracked in-repo, and carries its own tests.

## Protocol realities

Five constraints shape the design. Each was verified against upstream source,
not documentation.

### Listeners emit registration-time indices

`handler.py:61-83` builds a closure over the `params` supplied at registration
and sends `(*params, *value)`. Delete a track and the listener attached to the
object formerly at index 3 keeps firing labelled `3`, while that object now sits
at index 2. The index in a packet does not reliably name the object it named at
subscribe time.

### Targeted `stop_listen` leaks the listener

Worse: `_stop_listen` resolves its target from the *current* index, then calls
`remove_..._listener` on that object — removing a callback that was registered
on a *different* object. The call raises, `handler.py` swallows it as "likely
benign", and `del self.listener_functions[key]` runs anyway.

**The registry entry disappears while the real LOM listener stays attached for
the rest of the session.** It keeps emitting at the old index, byte-identical to
legitimate traffic at that index. No client-side epoch or generation filter can
separate the two. The only clean reset is `/live/api/reload`, which upstream
documents as development-only.

### Therefore: subscribe to singletons, poll everything indexed

This is the central architectural consequence. The leak is unfixable from the
client, so the design never creates it.

**Subscribed** — objects with no index, which therefore never churn and never
leak. Registered once on connect, torn down only on disconnect:

- `/live/song/start_listen/` — `tempo`, `is_playing`, `root_note`, `scale_name`,
  `loop`, `loop_start`, `loop_length`, `signature_numerator`,
  `signature_denominator`
- `/live/song/start_listen/beat` — the transport clock. **Not**
  `current_song_time`, whose LOM listener fires many times per second; upstream
  built the `beat` event specifically to avoid it (`song.py:271-284`).
- `/live/view/start_listen/selected_track`, `selected_scene`

**Polled** — everything keyed by an index:

| What | Rate | Cost |
| --- | --- | --- |
| Track names, mute, solo, device class lists | 2 s | one `track_data` call |
| Track faders and pans | 2 s | one `track_data` call (fork) |
| Selected clip, selected device | 1 s | two messages |
| Focused MIDI clip notes | 1.5 s | paged, focused clip only |
| Master meter | 2 s | one message (fork) |
| Per-track meters, focused/armed/soloed only | 2 s | bounded small set |

Polling costs latency on state a producer changes a few times a minute. In
exchange it deletes the topology watcher, the subscription rebuild machinery,
the rebuild storms, and the phantom-listener class of bug entirely. All of that
existed only to service subscriptions the design no longer needs.

### Inbound packets are observations first

A subscription update and a query reply arrive at the **same address** with no
request ID. So every inbound packet updates the mirror unconditionally, and a
separate request table resolves promises:

- Single-flight per `(address, key-args)`. A duplicate request attaches to the
  existing promise rather than sending a second packet.
- A pending entry resolves on the first matching inbound message, then clears.
- An unmatched inbound message is a subscription update. Mirror only.
- Every request carries a timeout.

**Key arity varies per endpoint** and must be declared, not inferred:
`/live/track/get/volume` echoes 1 index, `/live/track/get/send` 2,
`/live/clip/get/notes` 2, `/live/device/get/parameter/value_string` 3, and
`track_data` / `track_names` echo **none at all** — a bare flat tuple with no
range or property list. `requests.rs` owns an explicit arity map with a test
enumerating every endpoint the design uses. One wrong entry silently
cross-resolves queries for different objects.

**Keyless queries are serialized.** At most one `track_data` or `track_names`
outstanding at a time, because nothing in the reply identifies which request it
answers. After a timeout, the snapshot restarts at a new generation rather than
reissuing, so a late zombie reply cannot be mistaken for a fresh one. Parsing a
`track_data` reply also requires `num_scenes` and per-track `num_devices` up
front, since the clip and device segments are positional.

**A generation counter** guards in-flight work. Any change in track count or
ordering increments it; requests issued under an older generation are cancelled
rather than resolved.

### Datagram budget

`clip_get_notes` (`clip.py:132-143`) flattens every note into one flat tuple,
and `osc_server.py:83` sends it as a single `sendto`. macOS caps UDP datagrams
at `net.inet.udp.maxdgram` — **9216 bytes**, confirmed on the target machine.
Past roughly 450 notes, `sendto` raises and the client receives *nothing*. This
is hard failure, not truncation, and it would hit exactly the dense clips most
worth discussing.

Every bulk query is therefore budgeted in **bytes, not object counts**:

- Notes are paged with the 4-argument ranged form of `/live/clip/get/notes`
  (`pitch_start, pitch_span, time_start, time_span`, confirmed present) by time
  window, reassembled client-side.
- `track_data` chunks are sized against the byte budget, using `num_scenes` and
  `num_devices` to predict reply size — never a fixed track count.
- `get_device_params` on a Rack can expose hundreds of parameters and is paged
  the same way.

`missing_reason` distinguishes **"reply too large to send"** from **"Live did
not answer"**. Repeated instant timeouts on one clip surface as "clip too dense
to read", not as a connection problem.

## Architecture

```
Ableton Live 12.2.5 Suite
  └─ AbletonOSC fork  (vendored, pinned, shipped with the installer)
        │  UDP 11000 out / 11001 in
        ▼
  Tauri v2 desktop app  (always on top, small, frameless)
    ┌─ Rust — the protocol layer ────────────────────────────┐
    │  socket.rs    UDP, OSC codec                           │
    │  requests.rs  single-flight table, arity map, timeouts │
    │  subs.rs      singleton subscriptions only             │
    │  pollers.rs   indexed state, selection, notes, meters  │
    │  budget.rs    byte-budgeted chunking and paging        │
    │  deltas.rs    coalesce observations → state deltas     │
    │  model.rs     HTTPS to provider; holds the API key     │
    └────────────────────────────────────────────────────────┘
                    │  coalesced deltas, not raw packets
    ┌─ TypeScript (webview) — the domain layer ──────────────┐
    │  live/     set model, applies deltas, observation log  │
    │  digest/   structured brief; music + mixer analysis    │
    │  rules/    pure nudge predicates                       │
    │  model/    provider interface + adapter                │
    │  agent/    conversation and tool loop                  │
    │  ui/       chat pane, nudge feed, session context      │
    └────────────────────────────────────────────────────────┘
```

The split follows one rule: **Rust owns anything whose correctness depends on
not being interrupted or reloaded** — sockets, in-flight requests,
subscriptions. A webview reload must not orphan a subscription inside Live.

Everything above that line is domain logic we expect to iterate on hard:
musical analysis, digest wording, rule thresholds, prompts. It stays in
TypeScript, where iteration is cheap. A reload costs a resnapshot and nothing
more.

Rust never forwards raw packets. It coalesces observations into deltas every
250 ms, so a meter stream never becomes thousands of IPC messages.

## The digest

Two parts. A **structured JSON payload** carries the facts. A **short text
summary** orients the model.

```
SET  128 BPM · 4/4 · C minor · 96 bars · Arrangement view
GOAL  "rolling minimal techno, ref: Zip - Mono, want the breakdown to land"
FOCUS  tr3 "Bass" › clip "Bass A" (bars 17-25) › EQ Eight · playing, bar 21
OBSERVED, LAST 60s  Bass A note content changed ×6 · EQ Eight "Freq 1" moved

TRACKS
 1 Kick   aud -3.0 dB  [Drum Rack › Saturator]               4 clips
 2 Bass   mid -6.5 dB  [Operator › EQ Eight › Compressor]     3 clips
 M Master     -0.5 dB  [Limiter]

MIXER
 Kick   EQ8: HP 30Hz · bell +3dB @ 60Hz
 Bass   EQ8: HP 80Hz · bell -2dB @ 250Hz | Comp: -18dB 4:1, sidechain ← Kick
 Master Limiter: ceiling -0.3dB

ARRANGEMENT   1----8---16---24---32---40---48
 Kick         ....████████████████........
 Bass         ........████████████........
 sections: intro 1-16 · A 17-32 · nothing past 48

MIDI  Bass A (8 bars, 32 notes): C1-G2, root C, mostly 1/8, degrees 1 b3 5 b7
```

The observation line states what was observed, never what the producer intended.

### Session context

`GOAL` is a persistent free-text field the producer edits in the UI — genre,
reference track, today's objective — injected into the system prompt.

Without it the model has state but no intent, and "the arrangement is thin" has
opposite answers for minimal techno and pop, so every response hedges into
uselessness. This is the cheapest thing in the spec and probably the highest
leverage. Chat history persists for the session alongside it.

### Mixer summary

Precomputed into the structured payload, refreshed on device-chain change rather
than per question: per track — fader, pan, sends — plus **extracted headline
parameters for known stock device classes**:

| Device | Extracted |
| --- | --- |
| EQ Eight | per band: on, type, frequency, gain |
| Compressor | threshold, ratio, attack, release, **sidechain source** |
| Limiter | ceiling |
| Utility | gain, width |
| Auto Filter | type, frequency, resonance |

This exists because pillar 2 is inherently cross-track. Answering "do my kick
and bass fight?" needs EQ and compressor settings across many tracks at once,
and the only other path is `get_device_params` one device per call — roughly 90
serialized round trips on a 30-track set. No model will issue those, so it would
answer from device names alone and produce filler the producer has read a
hundred times. Sidechain source is the single highest-value fact for an
electronic producer and is otherwise invisible.

The extractor covers stock devices only. Third-party plugins fall back to name
and parameter count, and the digest says so.

### Sections

A heuristic, not a claim about intent. A boundary is marked where the set of
tracks holding a clip changes, quantised to the nearest 8 bars. Sections are
labelled by position (`intro`, then `A`, `B`, …), never by genre function.

### Budget

The digest is capped at **~4k tokens**. Included in full by default: the focused
clip's raw notes, and the selected device's parameters. Both are unbounded in
principle — Operator has ~130 parameters, an Instrument Rack can exceed a
thousand — so both are capped with an explicit truncation marker. Large sets cap
track count the same way: focused track and neighbours in full, the rest
summarized.

### Tools

Tools are **live queries against Live**, not mirror reads. The mirror
deliberately does not hold notes or device parameters for the whole set.

| Tool | Returns |
| --- | --- |
| `get_clip_notes(track, clip)` | Raw note list, paged |
| `get_device_params(track, device)` | Parameter names and formatted values, paged |
| `get_track_detail(track)` | Full state for one track |
| `get_arrangement()` | Every arrangement clip with start and length |

Every result carries `queried_at`, `fresh`, and `missing_reason`, so the model
can tell "this is zero" from "Live did not answer" from "too large to send".

## Nudges

Deterministic predicates over the state stream. No model call until one trips;
then the rule and the digest go to the model, which writes one sentence.

| Rule | Trigger |
| --- | --- |
| `off_scale_notes` | Focused clip's notes fall outside the set's `root_note` / `scale_name`, above a share threshold |
| `master_level_high` | Master meter sustained near 1.0 across a window |
| `unnamed_tracks` | Six or more default-named tracks in a set past a size threshold |
| `loop_fatigue` | Same loop brace over 8 minutes with no arrangement growth — **opt-in, off by default** |

`off_scale_notes` is the always-on rule that carries a first session. It is
deterministic, musically specific, and runs on data the focused-clip poller
already collects. It fires only when Live's scale is actually set.

`master_level_high` is named for what it measures. `output_meter_level` is a
0–1 level sampled at 2 s, not a peak meter, so the rule may not claim clipping,
and meters are never presented as level information anywhere else.

Cut, with reasons: `gain_staging` (a fader above unity is not wrong),
`flat_velocity` (deliberate in most electronic music), `arrangement_stall`
(punishes sound-design sessions), `untouched_device` (needs a per-device default
table and still means little).

Global cooldown of 10 minutes. Per-rule disable, not only a global mute. Every
nudge is dismissible.

## Untrusted input and privacy

Track, clip, and device names flow straight into the prompt. A downloaded
template or a collaborator's stem pack can carry a name written to steer the
model. Read-only, the blast radius is bad advice — but the digest format
designed now becomes the injection surface when writes arrive. All set-derived
strings are fenced with delimiters and declared to the model as data, never
instructions.

Separately, and stated plainly because the producer should decide knowingly:
**the set's names, structure, and raw MIDI stream continuously to a cloud model
provider.** A local-model adapter is out of scope for the MVP but the provider
interface does not preclude one.

## Response latency

Streaming is deferred by decision. A question triggers 2–4 model round trips
plus serialized OSC queries, so first text may take 15–30 seconds.

Mitigation that does not touch the interface: the UI shows live tool-call
progress ("reading EQ Eight on Bass…") so the wait is legible rather than a dead
window. If that proves insufficient in real use, adding streaming changes the
`ModelProvider` contract, its contract tests, and the agent loop — a known,
accepted retrofit cost.

## Model layer

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
exercise multi-turn tool calling. A second follows once those tests exist to
hold it honest. "OpenAI-compatible by base URL" is not true in practice for tool
calls, so it is not treated as free.

The system prompt and the allowed tool schema are backend-owned, so the webview
cannot widen them. The API key lives in Rust and never enters the web context.

## Error handling

- **Live closed, or the script not selected as a Control Surface.** A "not
  connected" banner, reconnect with backoff, singleton subscriptions
  re-registered on reconnect. Never a hang.
- **Dropped replies.** Per-request timeouts mark the affected slice stale. The
  digest renders what it has and names what is missing.
- **Oversized replies.** Byte-budgeted paging, with `missing_reason` separating
  "too large" from "no answer".
- **Provider errors.** Surfaced as text in the chat. The app keeps running.

## Testing

**Automated.** Record real OSC traffic into fixtures and replay against real
code. Tests call real code; no business logic is reimplemented in a test.

- `requests.rs` — interleave subscription updates and query replies on the same
  address; assert correct resolution and no cross-talk. Assert the arity map
  covers every endpoint used. Assert a late zombie `track_data` reply cannot
  resolve a reissued request.
- `budget.rs` — note paging across the 9216-byte boundary; assert reassembly is
  lossless and that an oversize reply reports "too large", not "timed out".
- `pollers.rs` — assert the note-diff baseline resets when the focused clip's
  `(track, scene)` identity changes, so a selection change never reports a
  phantom edit.
- `digest/music.ts`, `digest/mixer.ts` — pure functions over note lists and
  device parameter sets.
- `digest/build.ts` — snapshot tests, including the 4k-token cap and truncation
  markers.
- `rules/` — pure predicates over crafted snapshots, both directions.
- `model/` — provider contract tests covering multi-turn tool calling.
- `agent/loop.ts` — a stub provider returning scripted tool calls; assert the
  loop executes them and terminates.

**Manual, against real Live.** Fixture replay cannot catch listener lifecycle
bugs, UDP loss, or Live UI-thread stalls. Run before each release:

1. Connect, resnapshot, confirm the digest matches the set.
2. Add, delete, and reorder tracks; confirm no state lands under the wrong
   track and no subscription is created against an index.
3. Change the selected track, clip, and device; confirm focus tracks it and no
   phantom note edit is reported.
4. Edit notes in the focused MIDI clip; confirm the diff appears.
5. Open a clip with 500+ notes; confirm paging works rather than timing out.
6. Load a 50-plus track set; measure digest build time and Live's
   responsiveness. Benchmark at 20, 50, 100 tracks.
7. Restart the script mid-session; confirm reconnect.
8. Reload the webview; confirm no orphaned subscriptions survive in Live.

## Setup the producer performs once

The installer places the vendored fork in
`~/Music/Ableton/User Library/Remote Scripts/`. The producer restarts Live,
selects the script under Preferences → Link/Tempo/MIDI → Control Surface, then
sets a model provider and key in the app.

## Risks

- **Advice quality without audio.** The narrowed mixing scope is honest, but
  whether settings-only critique is useful enough to justify the app remains the
  MVP's central bet. It is the reason to ship small.
- **Ambient value is thin by construction — accepted.** With a 10-minute
  cooldown and four conservative rules, early sessions may contain very few
  nudges. This is a deliberate choice, not a gap to close before shipping: a
  wrong or obvious nudge costs more trust than a missing one. The MVP is
  chat-first, and the rules stay conservative until real use shows which
  thresholds earn their interruption. Do not add rules to raise the nudge rate.
- **Fork maintenance.** Vendoring buys capability and costs upstream drift.
  Pinned by commit, with its own tests.
- **Third-party plugin parameters.** VST and AU parameters may return opaque
  names and normalised values. The mixer extractor covers stock devices only.
- **Polling latency.** 1–2 s staleness on indexed state. Accepted deliberately
  in exchange for deleting the phantom-listener bug class.
