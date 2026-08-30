# Arrangement view — Design

Date: 2026-08-30
Status: approved for planning

## Goal

The copilot cannot see the arrangement at all. Every tool it has reads the
session view: `get_clips` lists session slots, `get_clip_notes` reads one of
them, and the context block describes tracks with no timeline at all. During
the writing phase, when the producer is laying out sections on the timeline,
the copilot is blind to the thing being worked on.

This adds three things:

1. **Section names in the context block.** The producer's own locators, on
   every request, so the copilot answers in "thin from «Break» onward" rather
   than "around bar 96".
2. **An arrangement map.** What plays where: each track's timeline clips with
   their names, start times, and lengths.
3. **Notes in arrangement clips.** Which needs new handlers in our own
   connector package, and moves the wire version to 5.

## Non-goals

- **No writes.** Read-only, as everywhere else.
- **No arrangement automation, no envelopes, no takes.** Clips only.
- **No paging for the arrangement map.** Upstream returns a whole track's clip
  names in one reply. A track with enough clips to exceed the datagram cap
  reports as a named gap rather than being fetched in pieces. See "Known
  limitation" below.
- **No new addressing scheme for session clips.** `get_clip_notes` and
  `get_clips` are untouched.

## 1. The connector

### A new handler package

`remote-script/MixingPal/mixingpal/arrangement.py`, a sibling of
`ClipNotesHandler`, registered in `MixingPalManager.init_api` alongside it.
Three addresses in their own family, rather than extra arguments on upstream's
clip handlers, which index `track.clip_slots` and would collide:

| Address | Args | Reply |
| --- | --- | --- |
| `/live/arrangement_clip/get/length` | (track, index) | (track, index, length) |
| `/live/arrangement_clip/get/num_notes` | (track, index) | (track, index, count) |
| `/live/arrangement_clip/get/notes_window` | (track, index, window, pitch_start, pitch_span, start, span) | (track, index, window, *note 5-tuples) |

Same argument order and the same reply shapes as the session pair, built by
reusing `clip_replies.py`'s `notes_window_reply` and `num_notes_reply`. The
reuse is the point: identical wire shapes let the Rust side reuse
`clip_notes.rs`'s decoder, window halving, and retry budget rather than growing
a second copy of the most delicate code in the app.

Resolution is `track.arrangement_clips[index]`, returning `None` for an
out-of-range index, which sends no reply at all. That is what `clip_at`
already does for an empty session slot, so the client sees a "no reply" it
already knows how to report.

### The wire version

`WIRE_VERSION` 4 → 5 in `remote-script/MixingPal/mixingpal/version.py`, and
`shared/wire-version.json` with it. A Rust test pins the two together.

`version.py`'s comment documents what each bump means for a stale script, and 5
gets the same treatment: **a script older than 5 knows none of these
addresses, so arrangement note reads return nothing after the client exhausts
its retry budget, while session reads keep working normally.** The connect-time
banner asks for a reinstall.

This is the real cost of the feature. Every producer on the current connector
sees "your connector is stale" until they reinstall and restart Live.

## 2. The app

### Section names in the context block

`/live/song/get/cue_points` replies `(name, time, name, time, …)`.

Upstream registers it as a plain handler rather than through its property list,
so **it has no `start_listen` and cannot be subscribed.** It has to be polled.
Locators change when the producer drops one, which is rare, so it gets its own
`PollKind::CuePoints` at 5 seconds, the cadence `ScriptVersion` already uses for
another value that changes rarely.

The path a value takes to the digest is fixed by existing machinery, and every
step needs a change:

| Step | Change |
| --- | --- |
| `osc/arity.rs` | `/live/song/get/cue_points` → `KeyArity::None` |
| `osc/pollers.rs`, `lib.rs` | new `PollKind::CuePoints`, 5s |
| decoder | pairs → `Vec<CuePoint { name, time }>`; fail closed on an odd length or a wrong type, because a half-decoded locator list would misplace every section after the bad entry |
| `shared/handled-addresses.json` | add to `songFields`, or the `lib.rs` and `addresses.test.ts` consistency tripwires both fail |
| `src/live/apply.ts` | handled directly in `applyDelta`, not through `SONG_FIELDS`, which maps scalars only. `NUM_TRACKS_ADDR` is the existing precedent for this |
| `src/live/model.ts` | `SetState.cuePoints: CuePoint[]` |
| `src/digest/build.ts` | render the `SECTIONS` line |

Rendering:

```
SET  132 BPM · A Minor · stopped
SECTIONS (beats)  «Intro» 0, «Verse» 32, «Drop» 64, «Break» 96
GOAL  dark garage, 2am
```

Names are fenced, because they are producer-controlled text like every other
name in the digest. The unit is named in the line itself: a bare `«Verse» 32`
leaves the model to guess bars or beats, and it will guess wrong half the time
against a producer reading bars off Live's ruler. Positions are in **beats**,
not bars, because the
arrangement map reports clip starts and lengths in beats and two units in one
answer is worse than one unfamiliar one. A set with no locators omits the line
entirely rather than printing an empty one.

### `get_arrangement`

A whole-set tool, no arguments, in `src-tauri/src/tools/arrangement.rs`,
modelled on `clips.rs`. Three addresses fanned out per track, all `3N` in
flight at once, for the same reason the other whole-set reads are:

```
/live/track/get/arrangement_clips/name        (already Args(1) in arity.rs)
/live/track/get/arrangement_clips/start_time  (new arity entry)
/live/track/get/arrangement_clips/length      (new arity entry)
```

```rust
pub struct ArrangementClip { pub index: i32, pub name: String, pub start: f32, pub length: f32 }
pub struct TrackArrangement { pub track: i32, pub clips: Vec<ArrangementClip> }
pub struct ArrangementMap {
    pub tracks: Vec<TrackArrangement>,
    /// Asked, no usable answer.
    pub missing: Vec<i32>,
    /// Names arrived, but the three lists disagreed in length.
    pub partial: Vec<i32>,
}
```

`index` is the clip's position in that track's `arrangement_clips` list, and it
is exactly what `get_arrangement_notes` takes. Both tool descriptions say so.

A track with an empty `clips` list genuinely has nothing on the timeline. It is
never "we could not read it", which is what `missing` says instead. Same rule
as `ChainMap` and `ClipMap`, and it matters more here: an empty arrangement
track is the normal state early in the writing phase, which is exactly when
this feature gets used.

The three replies are separate datagrams and can disagree if the producer edits
between them. A track whose three lists differ in length goes in `partial`
rather than being zipped to the shortest, for the same reason `mark_racks`
refuses a mismatched flag list: a misaligned zip reports the wrong clip at the
wrong time, which is worse than a named gap.

Cue points are **not** returned here. They are already in the mirror and in
every context block, so fetching them again would be a second source of truth
for the same values.

Reuses `MAX_FANOUT_TRACKS` for the cap and `chains_moved` for the topology
bracket, as `get_clips` does.

### `get_arrangement_notes`

Arguments `track` and `index`. Returns the same payload shape as
`get_clip_notes`, plus the clip's **name and start time**, so the model can
notice when the clip it read is not the clip it meant. Arrangement indices
shift when a clip is added earlier in the timeline, and a read taken after such
an edit silently lands on a neighbour. Echoing the identity back is the cheap
half of a guard; the model comparing it against the map it already fetched is
the other half, and the tool description says to do that.

Implementation reuses `clip_notes.rs`'s paging by parameterising the address
family it queries rather than copying it. That is a surgical change to shipped,
tested code, and it is justified: the alternative is a second copy of the
window-halving and retry logic, which is the code in this app most likely to be
got subtly wrong.

### Prompt and digest pointer

`SYSTEM_PROMPT` gains an arrangement rule shaped like the clip rule: the
context block names the sections but says nothing about what plays in them; for
that, call `get_arrangement`; for the notes in a timeline clip, call
`get_arrangement_notes`; session slot indices and arrangement indices are
different numbers and are not interchangeable.

`build.ts`'s closing pointer sentence gains both tools. The existing tripwires
force this: one asserts every schema tool is named in the prompt, another that
every schema tool appears in the digest sentence.

## 3. Verification

### Automated

- Decoder tests for all three new reply shapes, including fail-closed on a
  wrong type and on an odd-length cue point list.
- Fan-out tests for `get_arrangement`, including a silent track landing in
  `missing` and a length-mismatched track landing in `partial`.
- `hold_until_all_arrive` in the fake, as `clips.rs` uses, so the `3N`
  concurrency claim is asserted rather than described.
- Digest tests: sections rendered with fencing, and the line omitted entirely
  when there are no locators.
- The wire-version test already pins `version.py` against
  `shared/wire-version.json`; it will fail until both move to 5.
- The eval fixture gains arrangement clips and cue points.
  `shared/eval-context.txt` is regenerated, and its pin test fails until it is.
- One new eval scenario: "where is the arrangement thin?" must call
  `get_arrangement` before answering.

### Manual, against real Live

A new `## Arrangement` section in `docs/manual-verification.md`, alongside
`## Clips`:

- `/live/song/get/cue_points` replies as flat `(name, time)` pairs, and a set
  with no locators replies with an empty list rather than not replying.
- Arrangement clip indices match what `get_arrangement` reported: read a clip,
  confirm the echoed name and start match the map.
- Add a clip earlier in the timeline, re-read by the old index, and confirm the
  echoed identity no longer matches. This is the failure the echo exists for.
- A track with many arrangement clips (a chopped vocal): confirm whether the
  name reply arrives or exceeds the datagram cap and reports as missing.
- **Stale-connector behaviour:** run a v4 script against a v5 app. Session
  reads must keep working, arrangement note reads must fail as a named gap, and
  the banner must ask for a reinstall.

## Known limitation

Upstream returns a whole track's arrangement clip names in one reply, with no
ranged variant. A track with enough clips to push that reply past the
9216-byte datagram cap makes Live's `sendto` raise, the client receives
nothing, and the track lands in `missing`. A chopped vocal track can plausibly
reach that.

Paging it means a ranged names endpoint in our connector, which is a second
feature. It is out of scope here, and the manual verification item above exists
to find out how close a real set gets.

## Success criteria

- The context block carries the producer's section names, fenced, on every
  request, and omits the line when there are no locators.
- `get_arrangement` reports every track's timeline clips with real indices,
  and names a track that did not answer rather than reporting it empty.
- `get_arrangement_notes` reads a timeline clip's notes and echoes back the
  clip's identity.
- A stale connector degrades to a named gap on arrangement notes and keeps
  session reads working.
