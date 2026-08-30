# Arrangement view — Design

Date: 2026-08-30
Status: approved for planning (revised after a Codex review of the first draft)

## Goal

The copilot cannot see the arrangement at all. Every tool it has reads the
session view: `get_clips` lists session slots, `get_clip_notes` reads one of
them, and the context block describes tracks with no timeline. During the
writing phase, when the producer is laying sections out on the timeline, the
copilot is blind to the thing being worked on.

Three additions:

1. **Section names in the context block**, from the producer's own locators, on
   every request, so answers say "thin from «Break» onward" rather than
   "around bar 96".
2. **An arrangement map**: each track's timeline clips with names, start times,
   and lengths.
3. **Notes in arrangement clips.**

## What the first draft got wrong

A Codex review checked the draft's claims against the code. Three corrections
shaped this revision, and they are recorded here because each one is a trap the
implementation would otherwise fall into.

- **The draft said a script older than 5 "knows none of these addresses".**
  False. `/live/song/get/cue_points` (`abletonosc/song.py:241`) and all three
  `/live/track/get/arrangement_clips/*` endpoints (`abletonosc/track.py:135`)
  are already in the vendored script at wire version 4. Only the note
  endpoints genuinely need new handlers.
- **The draft's mis-zip guard was too weak.** Fanning out three separate
  upstream endpoints and rejecting a length mismatch still mis-zips silently
  when the producer edits between replies and the lists happen to stay the same
  length. Three endpoints are not an atomic snapshot.
- **The draft's identity guard was not this codebase's pattern.** It proposed
  echoing a clip's name and start so the model could notice a shifted index.
  `device_params.rs:203,267` and `rack_contents.rs:169` instead bracket a paged
  read with an identity check in Rust and refuse the data if it moved.

Given the second point, and given that notes need a connector package anyway,
**the arrangement map moves into our own connector as one atomic endpoint.**
That costs the no-reinstall property the first correction revealed, and buys an
unmis-zippable read at N requests instead of 3N.

## Non-goals

- **No writes.** Read-only, as everywhere else.
- **No automation, envelopes, or takes.** Clips only.
- **No new addressing for session clips.** `get_clips` and `get_clip_notes` are
  untouched.

## 1. The connector

New file `remote-script/MixingPal/mixingpal/arrangement.py`, a sibling of
`ClipNotesHandler`, registered in `MixingPalManager.init_api` alongside it.

### The map endpoint

```
/live/mixingpal/get/arrangement   (track, start, span)
  -> (track, start, total_clips, *(name, start_time, length) triples)
```

Ranged, following `rack.py`'s `(track, path, start, span)` precedent and its
`build_window` helper. Ranging is not optional decoration: upstream's
`arrangement_clips/name` returns a whole track's names in one reply, and a
chopped vocal track can push that past the 9216-byte datagram cap
(`osc/budget.rs:1`), at which point Live's `sendto` raises, the script's `send`
does not catch it (`abletonosc/osc_server.py:79,186`), and the client sees
silence indistinguishable from a lost packet. Owning the endpoint is what lets
that limitation go away instead of being documented forever.

One reply carries all three values per clip, so the three cannot disagree. That
is the whole reason this is a custom endpoint rather than three upstream reads.

### The note endpoints

```
/live/arrangement_clip/get/length        (track, index)
/live/arrangement_clip/get/num_notes     (track, index)
/live/arrangement_clip/get/notes_window  (track, index, window, pitch_start, pitch_span, start, span)
```

Same argument order and the same reply shapes as the session pair, built by
reusing `clip_replies.py`'s `notes_window_reply` and `num_notes_reply`. The
reply must stay `(track, index, window, *note 5-tuples)` and the address must
be `KeyArity::Args(3)`, because those two facts together are what let
`clip_notes.rs`'s decoder be reused rather than copied. `clip_notes.rs`
hard-codes its three addresses today (`:230`, `:236`, `:300`), so the fetch
path is parameterised by address family; the decoder, window halving, and
retry budget are not touched.

Resolution is `track.arrangement_clips[index]`, returning `None` for an
out-of-range index, which sends no reply at all. That is what `clip_at` already
does for an empty session slot, so the client sees a "no reply" it already
handles.

### The wire version

`WIRE_VERSION` 4 → 5, and `shared/wire-version.json` with it; a Rust test pins
the two together. `version.py`'s comment gets an entry for 5 in the style of
the existing 3 and 4 notes: a script older than 5 knows neither the arrangement
map nor the arrangement note endpoints, so both report as a named gap while
session reads, mixer reads, and device reads keep working. The connect-time
banner asks for a reinstall.

Every producer on the current connector reinstalls and restarts Live. That is
the price of the atomic map, and it was a deliberate choice over shipping the
map on wire 4 with a residual mis-zip.

## 2. The app

### Section names in the context block

`/live/song/get/cue_points` replies `(name, time, name, time, …)`. Upstream
registers it as a plain handler rather than through its property list
(`song.py:245`), so it has **no `start_listen` and cannot be subscribed.** It
is polled by a new `PollKind::CuePoints` at 5 seconds, the cadence
`ScriptVersion` already uses for a value that changes rarely.

Every step of the path a song value takes to the digest needs a change, and
two of them are tripwires that fail loudly if skipped:

| Step | Change |
| --- | --- |
| `osc/arity.rs` | `/live/song/get/cue_points` → `KeyArity::None` |
| `osc/pollers.rs`, `lib.rs` | new `PollKind::CuePoints`, 5s |
| `lib.rs` `POLL_LOOP_SENT_ADDRESSES` | add it, or the read-only tripwire silently loses coverage. Its own doc comment says a new address belongs here in the same commit that first sends it |
| decoder | pairs → `Vec<CuePoint { name, time }>`; fail closed on an odd length or a wrong type, since a half-decoded list misplaces every section after the bad entry |
| `shared/handled-addresses.json` | add to `songFields`, or both consistency tests fail |
| `src/live/addresses.test.ts` | add to `handledOutsideFieldMaps`, which today holds only `NUM_TRACKS_ADDR` |
| `src/live/apply.ts` | handled directly in `applyDelta`, not via `SONG_FIELDS`, which copies scalars only |
| `src/live/model.ts` | `SetState.cuePoints: CuePoint[]` |
| `src/digest/build.ts` | render the `SECTIONS` line |

Rendering:

```
SET  132 BPM · A Minor · stopped
SECTIONS (beats)  «Intro» 0, «Verse» 32, «Drop» 64, «Break» 96
GOAL  dark garage, 2am
```

Names are fenced, like every other producer-controlled string in the digest.
The unit is named in the line: a bare `«Verse» 32` leaves the model to guess
bars or beats, and it will guess wrong against a producer reading bars off
Live's ruler. Beats, because the map reports clip starts and lengths in beats
and two units in one answer is worse than one unfamiliar one. A set with no
locators omits the line rather than printing an empty one.

### `get_arrangement`

Whole-set, no arguments, in `src-tauri/src/tools/arrangement.rs`, modelled on
`clips.rs`: one ranged request per track, all N in flight at once, paged per
track the way `rack_contents.rs` pages.

```rust
pub struct ArrangementClip { pub index: i32, pub name: String, pub start: f32, pub length: f32 }
pub struct TrackArrangement { pub track: i32, pub clips: Vec<ArrangementClip>, pub truncated: bool }
pub struct ArrangementMap { pub tracks: Vec<TrackArrangement>, pub missing: Vec<i32> }
```

`name` goes through `crate::tools::fence::fence`, like `decode_clips` does
(`clips.rs:65`). `index` is the clip's position in that track's
`arrangement_clips` list and is exactly what `get_arrangement_notes` takes;
both descriptions say so.

A track with an empty `clips` list genuinely has nothing on the timeline. It is
never "we could not read it", which is what `missing` says. Same rule as
`ChainMap` and `ClipMap`, and it matters more here: an empty arrangement track
is the normal state early in the writing phase, which is exactly when this gets
used.

`missing` and `truncated` are assembled into the tool's top-level
`missing_reason` by an extracted `arrangement_reasons` function, the way
`chain_map_reasons` and `clip_map_reasons` already work. Without that step
`ToolResult::live` marks a gapped result `fresh: true`, which is the
fabrication this design exists to avoid.

Reuses `MAX_FANOUT_TRACKS` for the cap and `chains_moved` for the topology
bracket, as `get_clips` does.

### `get_arrangement_notes`

Arguments `track` and `index`. Same payload shape as `get_clip_notes`.

**Identity is checked in Rust, not delegated to the model.** Before and after
the paged note read, the tool reads that clip's entry from
`/live/mixingpal/get/arrangement` with a one-clip range and compares
`(name, start, length)`. If it moved, the notes are dropped and the result
carries `arrangement_clip_identity_changed`. Arrangement indices shift when a
clip is added earlier in the timeline, and a read taken across such an edit
otherwise lands silently on a neighbour. The bracket reuses the map endpoint,
so it costs one extra request on each side and no new address.

The successful payload still echoes the clip's name and start, which is useful
context for the answer. It is no longer the guard.

Note for implementation: `RequestTable` supports int and string keys only and
treats floats as unsafe (`osc/requests.rs:54`), so start times must never
participate in transport keying. The bracket compares values in Rust; the
request key stays `(track, index, window)`.

### The receive-loop exclusion

Every new tool-only address must be added to `handle_inbound`'s exclusion list
(`lib.rs:272-296`): the arrangement map endpoint and all three arrangement note
endpoints. A reply not excluded there is retained in the coalescer, streamed to
the frontend in a `live://deltas` batch, and replayed on every webview reload,
permanently. The existing comment spells out why for clip notes: a 450-note
reply is roughly 2,250 JSON values and never evicts.

This was missing from the first draft entirely and is the single easiest way to
ship a memory leak here.

### Prompt and digest pointer

`SYSTEM_PROMPT` gains an arrangement rule shaped like the clip rule: the
context block names the sections but says nothing about what plays in them; for
that, call `get_arrangement`; for the notes in a timeline clip, call
`get_arrangement_notes`; session slot indices and arrangement indices are
different numbers and are not interchangeable.

`build.ts`'s closing pointer sentence gains both tools. Existing tripwires force
both changes: one asserts every schema tool is named in `SYSTEM_PROMPT`
(`model.rs:837`), another that every schema tool appears in the digest sentence
(`toolPointer.test.ts:33`).

## 3. Verification

### Tests that will fail until updated

- `the_schema_lists_exactly_the_six_tools_the_model_may_call`
  (`tools/mod.rs:994`) becomes eight.
- Both prompt/schema tripwires, until the prompt names both new tools.
- The digest pointer tripwire, until `build.ts` names them.
- The wire-version test, until `version.py` and `shared/wire-version.json` both
  read 5.
- The eval fixture pin, once `shared/eval-set.json` gains arrangement data and
  `shared/eval-context.txt` is regenerated with a `SECTIONS` line.

### New tests

- Decoders for the map reply and all three note replies, including fail-closed
  on a wrong type and on an odd-length cue point list.
- Fan-out: a silent track lands in `missing`; a truncated track reports
  `truncated` and a reason; `hold_until_all_arrive` asserts the N-in-flight
  claim rather than describing it.
- The identity bracket: a clip that moves between the two reads produces
  `arrangement_clip_identity_changed` and no notes.
- Digest: sections rendered and fenced; the line omitted with no locators.
- One eval scenario: "where is the arrangement thin?" must call
  `get_arrangement` before answering.

The eval work is larger than it looks. The Rust fake in `tests/evals.rs`
answers session clip addresses only (`:159`), and `shared/eval-set.json` has no
arrangement data (`:19`). Both need extending before any arrangement scenario
can run.

### Manual, against real Live

A new `## Arrangement` section in `docs/manual-verification.md`, beside
`## Clips`:

- `/live/song/get/cue_points` replies as flat `(name, time)` pairs, and a set
  with no locators replies with an empty list rather than not replying.
- Read a clip, confirm the echoed name and start match what the map reported.
- Add a clip earlier in the timeline mid-read and confirm the result reports
  `arrangement_clip_identity_changed` rather than a neighbour's notes.
- A track with hundreds of arrangement clips pages correctly and reports
  `truncated` at the cap rather than going silent.
- **Stale connector:** run a v4 script against a v5 app. Session, mixer, and
  device reads must keep working; the arrangement map and arrangement notes
  must both report a named gap; the banner must ask for a reinstall.

## Success criteria

- The context block carries the producer's section names, fenced, with the unit
  named, and omits the line when there are no locators.
- `get_arrangement` reports every track's timeline clips with real indices, in
  one atomic reply per track, and names a track that did not answer rather than
  reporting it empty.
- `get_arrangement_notes` refuses to return notes for a clip that moved during
  the read.
- No new address is retained in the coalescer or streamed to the frontend.
- A stale connector degrades to named gaps and keeps every session-view feature
  working.
