# Arrangement View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the copilot see the arrangement: the producer's section names in every context block, a map of what plays where on the timeline, and the notes inside a timeline clip.

**Architecture:** Two new connector endpoints in our own `mixingpal` package (the arrangement map, ranged and atomic, plus a note-reading family that mirrors the session one byte for byte), two new Rust tools built on the existing whole-set fan-out and paging machinery, and cue points polled into the mirror so the digest can name sections on every request. The wire version moves to 5.

**Tech Stack:** Python 3 (Live Remote Script, no third-party imports), Rust (tokio, rosc, serde_json), TypeScript (vitest), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-08-30-arrangement-view-design.md`

## Global Constraints

- **Read-only.** No `set` address is ever sent. Every new address is a `get`.
- **Never fabricate a value in place of a gap.** A failed read is reported through `missing_reason`; it is never defaulted, zeroed, or dropped. An empty list means "genuinely empty"; `missing` means "asked, no usable answer".
- **Set-derived strings are fenced.** Every producer-controlled string a tool or the digest returns goes through `crate::tools::fence::fence` (Rust) or `fence()` (TypeScript), which wraps it in `«»`.
- **Every new tool address must be added to BOTH lists in `src-tauri/src/lib.rs`:** `is_resolve_only` inside `handle_inbound` (or the reply is retained in the mirror, streamed to the webview, and replayed on every reload) and `POLL_LOOP_SENT_ADDRESSES` (or the read-only send guard stops covering it). `get_clips` shipped missing both; commit `06cbf24` is the fix and its test.
- **The wire version moves to 5** in `remote-script/MixingPal/mixingpal/version.py` and `shared/wire-version.json` together. A Rust test pins them.
- **The connector has no third-party imports.** Live's Python cannot install packages. Logic that needs testing goes in a Live-free module, as `rack_paths.py` and `clip_replies.py` already do.
- **Save test output, then grep it.** Run steps write to `.logs/` (gitignored). Cargo runs from `src-tauri/`, so its logs go to `../.logs/`.
- Commit messages end with:
  `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`

**Test commands:** `cd src-tauri && cargo test` · `npx vitest run` · `npm run test:script` (Python) · `npm run build` (tsc + vite)

---

### Task 1: Connector — the arrangement map endpoint

**Files:**
- Create: `remote-script/MixingPal/mixingpal/arrangement_replies.py`
- Create: `remote-script/MixingPal/mixingpal/arrangement.py`
- Modify: `remote-script/MixingPal/mixingpal/manager.py`
- Modify: `remote-script/MixingPal/mixingpal/version.py`
- Modify: `shared/wire-version.json`
- Test: `remote-script/tests/test_arrangement_replies.py`

**Interfaces:**
- Consumes: `AbletonOSCHandler` from `..abletonosc.handler`; the `MixingPalManager.init_api` handler list.
- Produces: the address `/live/mixingpal/get/arrangement` taking `(track, start, span)` and replying `(track, start, total, *(name, start_time, length))`; `clips_of(track)`; `window_of(entries, start, span, budget)`; `arrangement_reply(track_index, start, total, records)`; `WIRE_VERSION = 5`.

- [ ] **Step 1: Write the failing Python tests**

Create `remote-script/tests/test_arrangement_replies.py`:

```python
import unittest

from MixingPal.mixingpal.arrangement_replies import (
    NAME_CAP, arrangement_reply, clips_of, window_of,
)


class FakeClip:
    def __init__(self, name, start_time, length):
        self.name = name
        self.start_time = start_time
        self.length = length


class FakeTrack:
    def __init__(self, clips):
        self.arrangement_clips = clips


class ClipsOf(unittest.TestCase):
    def test_returns_name_start_and_length_in_timeline_order(self):
        track = FakeTrack([FakeClip("Verse", 32.0, 64.0), FakeClip("Fill", 60.0, 4.0)])
        self.assertEqual(
            clips_of(track),
            [("Verse", 32.0, 64.0), ("Fill", 60.0, 4.0)],
        )

    def test_a_track_with_nothing_on_the_timeline_is_empty_not_an_error(self):
        # Normal early in the writing phase, and the client must be able to
        # tell it apart from a track that did not answer.
        self.assertEqual(clips_of(FakeTrack([])), [])

    def test_a_long_name_is_capped_on_the_wire(self):
        track = FakeTrack([FakeClip("x" * 500, 0.0, 4.0)])
        self.assertEqual(len(clips_of(track)[0][0]), NAME_CAP)


class WindowOf(unittest.TestCase):
    def test_returns_at_most_span_records_from_start(self):
        entries = [("a", 0.0, 4.0), ("b", 4.0, 4.0), ("c", 8.0, 4.0)]
        self.assertEqual(window_of(entries, 1, 2, budget=8960), entries[1:3])

    def test_a_start_past_the_end_returns_nothing_rather_than_raising(self):
        self.assertEqual(window_of([("a", 0.0, 4.0)], 5, 2, budget=8960), [])

    def test_the_budget_cuts_the_window_short(self):
        # The sender owns the window, because only it knows the byte sizes.
        # A reply past the datagram cap makes Live's sendto raise and the
        # client receives nothing at all.
        entries = [("x" * 100, float(i), 4.0) for i in range(50)]
        got = window_of(entries, 0, 50, budget=400)
        self.assertGreater(len(got), 0)
        self.assertLess(len(got), 50)

    def test_one_oversized_record_is_still_returned(self):
        # Every reply carries at least one record, or the client's paging
        # loop cannot make progress.
        entries = [("x" * 500, 0.0, 4.0)]
        self.assertEqual(len(window_of(entries, 0, 10, budget=10)), 1)


class ArrangementReply(unittest.TestCase):
    def test_flattens_records_after_the_echoed_header(self):
        reply = arrangement_reply(2, 1, 7, [("Verse", 32.0, 64.0)])
        self.assertEqual(reply, (2, 1, 7, "Verse", 32.0, 64.0))

    def test_the_header_carries_the_true_total_not_the_window_size(self):
        # The client pages until it has `total`; reporting the window size
        # would stop it after one page and silently truncate the timeline.
        reply = arrangement_reply(0, 0, 40, [("a", 0.0, 4.0)])
        self.assertEqual(reply[2], 40)
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
mkdir -p .logs && npm run test:script 2>&1 | tee .logs/t1-red.log; grep -n "ModuleNotFoundError\|ImportError" .logs/t1-red.log | head -3
```

Expected: `ModuleNotFoundError: No module named 'MixingPal.mixingpal.arrangement_replies'`.

- [ ] **Step 3: Write the Live-free reply module**

Create `remote-script/MixingPal/mixingpal/arrangement_replies.py`:

```python
"""Reply shapes for the arrangement endpoints, in a module Live cannot reach.

Same reason `clip_replies.py` and `rack_paths.py` exist: the client decodes
these tuples positionally, so the ORDER of a clip's three fields and the
position of the echoed header are a contract between this file and
`src-tauri/src/tools/arrangement.rs`. Getting either wrong produces a
timeline that is plausible and wrong.

Nothing here imports Live, so `remote-script/tests` can exercise it directly.
"""

# Caps every name on the wire. The Rust side fences to 120 characters anyway,
# so a longer one cannot survive the trip intact.
NAME_CAP = 120

# One datagram's worth, under the 9216-byte macOS UDP cap with room for the
# address and type tags. Past it, Live's sendto raises and the client receives
# nothing at all -- silence indistinguishable from a lost datagram.
MAX_REPLY_BYTES = 8960


def clips_of(track):
    """Every arrangement clip, as (name, start_time, length).

    One pass over `track.arrangement_clips`, so the three values of a clip
    are read together and cannot disagree. Reading them from three separate
    endpoints is what this endpoint exists to avoid: three replies are three
    moments, and a producer editing between them mis-zips the timeline
    silently.
    """
    return [
        (str(clip.name)[:NAME_CAP], float(clip.start_time), float(clip.length))
        for clip in track.arrangement_clips
    ]


def _record_bytes(record):
    """Roughly what one record costs on the wire.

    The name is the only variable part; the two floats are 4 bytes each plus
    type tags, and OSC pads strings to a 4-byte boundary. Deliberately an
    over-estimate: under-counting is what makes sendto raise.
    """
    name = record[0]
    return ((len(name) + 4) // 4) * 4 + 16


def window_of(entries, start, span, budget=MAX_REPLY_BYTES):
    """Records from entries[start:], at most `span` and at most what fits.

    The HANDLER owns the window, not the client, for the reason `rack_paths`'
    `build_window` documents: only the sender knows the byte sizes, and a
    client-side window sized for short names serialises a track of long ones
    past the cap.

    A single oversized record is still returned, so every reply carries at
    least one and the client's paging loop always makes progress.
    """
    start = max(0, start)
    span = max(0, span)
    out = []
    used = 0
    for record in entries[start:start + span]:
        cost = _record_bytes(record)
        if out and used + cost > budget:
            break
        out.append(record)
        used += cost
    return out


def arrangement_reply(track_index, start, total, records):
    """`(track, start, total, *(name, start_time, length))`.

    `track` and `start` lead because the client's request table keys on the
    leading arguments of the request and the reply alike. `total` is the
    track's real clip count, not the window's: the client pages until it has
    them all, and a window-sized total would stop it early and present a
    truncated timeline as a complete one.
    """
    flat = [field for record in records for field in record]
    return (track_index, start, total, *flat)
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:script 2>&1 | tee .logs/t1-green.log; grep -n "OK\|FAILED" .logs/t1-green.log | tail -2
```

Expected: `OK`.

- [ ] **Step 5: Write the handler**

Create `remote-script/MixingPal/mixingpal/arrangement.py`:

```python
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .arrangement_replies import arrangement_reply, clips_of, window_of


class ArrangementHandler(AbletonOSCHandler):
    """Reads the arrangement.

    Upstream exposes a track's arrangement clips as three separate list
    endpoints (names, start times, lengths). Three endpoints are three
    moments: a producer editing between the replies leaves the client zipping
    a name to another clip's position, and when the lists happen to stay the
    same length nothing detects it. This endpoint answers all three fields
    for a clip in one reply, so they cannot disagree.

    Ranged for the reason `rack.py` is: a track with many clips serialises
    past the datagram cap, and only the sender knows the sizes.

    Returning None sends no reply at all (see `osc_server.process_message`'s
    `if rv is not None`), which is byte-identical to a lost datagram from the
    client's side. That is how "there is no track at that index" arrives.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "arrangement"

    def init_api(self):
        def track_at(index):
            tracks = self.song.tracks
            if index < 0 or index >= len(tracks):
                return None
            return tracks[index]

        def arrangement(params: Tuple[Any]):
            track_index = int(params[0])
            track = track_at(track_index)
            if track is None:
                return None
            start, span = max(0, int(params[1])), max(0, int(params[2]))
            entries = clips_of(track)
            records = window_of(entries, start, span)
            return arrangement_reply(track_index, start, len(entries), records)

        self.osc_server.add_handler(
            "/live/mixingpal/get/arrangement", arrangement)
```

Register it in `remote-script/MixingPal/mixingpal/manager.py`: add
`from .arrangement import ArrangementHandler` to the imports and
`ArrangementHandler(self),` to the `self.handlers` list, directly after
`ClipNotesHandler(self),`.

- [ ] **Step 6: Move the wire version**

In `remote-script/MixingPal/mixingpal/version.py`, append to the version
history comment, in the style of the existing 3 and 4 entries, then change the
constant:

```python
# Version 5 added /live/mixingpal/get/arrangement and the
# /live/arrangement_clip/get/* family. A stale script knows neither, so the
# arrangement map and arrangement note reads report a named gap while
# session, mixer and device reads keep working normally. Reinstalling is the
# fix, which is what the banner asks for.
WIRE_VERSION = 5
```

And `shared/wire-version.json`:

```json
{ "version": 5 }
```

- [ ] **Step 7: Run every suite**

```bash
npm run test:script 2>&1 | tee .logs/t1-script.log; grep -cE "^OK" .logs/t1-script.log
cd src-tauri && cargo test 2>&1 | tee ../.logs/t1-cargo.log; grep -E "test result|wire_version" ../.logs/t1-cargo.log | head -3
```

Expected: Python `OK`; `cargo test` passes, including
`wire_version_matches_the_shared_manifest`, which fails if `version.py` and
`shared/wire-version.json` disagree.

- [ ] **Step 8: Commit**

```bash
git add remote-script/MixingPal/mixingpal/arrangement_replies.py \
        remote-script/MixingPal/mixingpal/arrangement.py \
        remote-script/MixingPal/mixingpal/manager.py \
        remote-script/MixingPal/mixingpal/version.py \
        shared/wire-version.json remote-script/tests/test_arrangement_replies.py
git commit -m "$(cat <<'EOF'
Answer a track's arrangement in one reply

Upstream lists a track's arrangement clips as three separate endpoints, and
three replies are three moments: a producer editing between them leaves the
client pairing a name with another clip's position, undetectably when the
lists stay the same length. One endpoint answers all three fields per clip,
ranged the way rack chains are, because only the sender knows whether a
track's names fit in a datagram.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Connector — the arrangement note endpoints

**Files:**
- Modify: `remote-script/MixingPal/mixingpal/arrangement.py`
- Test: `remote-script/tests/test_arrangement_replies.py`

**Interfaces:**
- Consumes: `clip_replies.notes_window_reply` and `clip_replies.num_notes_reply` from Task 1's sibling module; `track_at` from Task 1's handler.
- Produces: `/live/arrangement_clip/get/length` `(track, index)`, `/live/arrangement_clip/get/num_notes` `(track, index)`, and `/live/arrangement_clip/get/notes_window` `(track, index, window, pitch_start, pitch_span, start, span)`, replying in exactly the session shapes: `(track, index, length)`, `(track, index, count)`, `(track, index, window, *note 5-tuples)`.

- [ ] **Step 1: Write the failing test**

Add to `remote-script/tests/test_arrangement_replies.py`:

```python
from MixingPal.mixingpal.clip_replies import notes_window_reply, num_notes_reply


class FakeNote:
    def __init__(self, pitch, start_time):
        self.pitch = pitch
        self.start_time = start_time
        self.duration = 0.5
        self.velocity = 100
        self.mute = False


class ArrangementNotesShareTheSessionShape(unittest.TestCase):
    def test_the_note_reply_is_byte_identical_to_the_session_one(self):
        # The Rust decoder is reused rather than copied, and it reads these
        # positionally. If the two shapes ever diverge, the arrangement read
        # returns notes that are plausible and wrong.
        notes = [FakeNote(60, 0.0), FakeNote(64, 1.0)]
        self.assertEqual(
            notes_window_reply(2, 7, 3, notes),
            (2, 7, 3, 60, 0.0, 0.5, 100, False, 64, 1.0, 0.5, 100, False),
        )

    def test_the_count_reply_is_byte_identical_to_the_session_one(self):
        self.assertEqual(num_notes_reply(1, 4, [FakeNote(60, 0.0)]), (1, 4, 1))
```

- [ ] **Step 2: Run it to verify it passes already**

```bash
npm run test:script 2>&1 | tee .logs/t2-shape.log; grep -n "OK\|FAILED" .logs/t2-shape.log | tail -1
```

Expected: `OK`. This test passes immediately and that is the point: it pins the
shared shape so a later edit to `clip_replies.py` cannot silently break the
arrangement decoder. Note it in the commit message as a pinning test, not a
red-green one.

- [ ] **Step 3: Add the three endpoints**

In `arrangement.py`, add these imports at the top:

```python
from .clip_replies import notes_window_reply, num_notes_reply
```

and inside `init_api`, after the `arrangement` handler:

```python
        def arrangement_clip_at(params):
            """The arrangement clip at (track, index), or None.

            None sends no reply, which is how "there is no clip there"
            reaches the client -- the same way an empty session slot does.
            """
            track = track_at(int(params[0]))
            if track is None:
                return None
            clips = track.arrangement_clips
            index = int(params[1])
            if index < 0 or index >= len(clips):
                return None
            return clips[index]

        def arrangement_length(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            return (int(params[0]), int(params[1]), float(clip.length))

        def arrangement_num_notes(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            notes = clip.get_notes_extended(0, 128, 0.0, float(clip.length))
            return num_notes_reply(int(params[0]), int(params[1]), notes)

        def arrangement_notes_window(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            window = int(params[2])
            from_pitch, pitch_span = int(params[3]), int(params[4])
            start, span = float(params[5]), float(params[6])
            notes = clip.get_notes_extended(from_pitch, pitch_span, start, span)
            return notes_window_reply(
                int(params[0]), int(params[1]), window, notes)

        self.osc_server.add_handler(
            "/live/arrangement_clip/get/length", arrangement_length)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/num_notes", arrangement_num_notes)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/notes_window", arrangement_notes_window)
```

- [ ] **Step 4: Run the Python suite**

```bash
npm run test:script 2>&1 | tee .logs/t2-green.log; grep -n "OK\|FAILED" .logs/t2-green.log | tail -1
```

Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add remote-script/MixingPal/mixingpal/arrangement.py remote-script/tests/test_arrangement_replies.py
git commit -m "$(cat <<'EOF'
Read notes from an arrangement clip

Upstream's clip endpoints index track.clip_slots, so an arrangement clip is
not addressable by them at all. These three mirror the session family
exactly and build their replies with the same clip_replies helpers, which is
what lets the Rust decoder, window halving and retry budget be reused rather
than copied. A test pins the two shapes together.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rust — reading the arrangement map

**Files:**
- Create: `src-tauri/src/tools/arrangement.rs`
- Modify: `src-tauri/src/tools/mod.rs` (module declaration only)
- Modify: `src-tauri/src/osc/arity.rs`
- Modify: `src-tauri/src/lib.rs` (`is_resolve_only`, `POLL_LOOP_SENT_ADDRESSES`, `TOOL_ONLY_REPLY_ADDRESSES`)
- Test: `src-tauri/src/tools/arrangement.rs` (`#[cfg(test)] mod tests`)

**Interfaces:**
- Consumes: `crate::osc::query::LiveQuery`, `crate::tools::fence::fence`.
- Produces:
  `pub struct ArrangementClip { pub index: i32, pub name: String, pub start: f32, pub length: f32 }`,
  `pub struct TrackArrangement { pub track: i32, pub clips: Vec<ArrangementClip>, pub truncated: bool }`,
  `pub struct ArrangementMap { pub tracks: Vec<TrackArrangement>, pub missing: Vec<i32> }`,
  `pub async fn get_arrangement(q: Arc<LiveQuery>, num_tracks: i32, timeout: Duration) -> ArrangementMap`,
  `pub const QUERY_TIMEOUT: Duration`, `pub const REQUEST_SPAN: usize`, `pub const MAX_WINDOWS: usize`,
  `pub async fn read_track(q: &LiveQuery, track: i32, timeout: Duration) -> Option<TrackArrangement>`.

- [ ] **Step 1: Add the arity entries and both address lists**

In `src-tauri/src/osc/arity.rs`, add to the `KeyArity::Args(3)` arm, beside
`/live/mixingpal/get/rack/chains`:

```rust
        // Reply is (track, start, total, *records). Keyed on (track, start)
        // plus the span, so two pages of one track are different requests
        // and a page the client gave up on cannot resolve another's.
        | "/live/mixingpal/get/arrangement"
```

and to the test's case table:

```rust
            ("/live/mixingpal/get/arrangement", KeyArity::Args(3)),
```

In `src-tauri/src/lib.rs`, add `"/live/mixingpal/get/arrangement"` to all three
of: `is_resolve_only`'s `matches!` block inside `handle_inbound`,
`POLL_LOOP_SENT_ADDRESSES`, and the test-only `TOOL_ONLY_REPLY_ADDRESSES`.
Missing the first retains one entry per track in the mirror forever; missing
the second drops it out of the read-only send guard. Commit `06cbf24` is why
this is step 1 rather than an afterthought.

- [ ] **Step 2: Write the failing decoder tests**

Create `src-tauri/src/tools/arrangement.rs` containing only the test module
below plus its `use` lines. It will not compile, which is the failure.

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_page_reads_the_header_then_every_triple() {
        let reply = vec![
            OscType::Int(2),
            OscType::Int(0),
            OscType::Int(7),
            OscType::String("Verse".into()),
            OscType::Float(32.0),
            OscType::Float(64.0),
            OscType::String("Fill".into()),
            OscType::Float(60.0),
            OscType::Float(4.0),
        ];
        let (start, total, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!((start, total), (0, 7));
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0].name, "«Verse»");
        assert_eq!((clips[0].start, clips[0].length), (32.0, 64.0));
    }

    #[test]
    fn decode_page_refuses_a_page_that_echoes_a_different_start() {
        // Defence in depth. The address is Args(3), so a stale page resolves
        // no pending request -- but a page decoded at the wrong offset would
        // number every clip after it wrongly, and the model sends those
        // numbers back to read notes.
        let reply = vec![OscType::Int(0), OscType::Int(4), OscType::Int(7)];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn decode_page_fails_closed_on_a_ragged_triple() {
        // Guessing which fields are missing would invent a timeline.
        let reply = vec![
            OscType::Int(0),
            OscType::Int(0),
            OscType::Int(1),
            OscType::String("Verse".into()),
            OscType::Float(32.0),
        ];
        assert!(decode_page(&reply, 0).is_none());
    }

    #[test]
    fn a_track_with_nothing_on_the_timeline_decodes_to_an_empty_page() {
        // Empty is a real answer, and it is the normal one early in the
        // writing phase.
        let reply = vec![OscType::Int(3), OscType::Int(0), OscType::Int(0)];
        let (_, total, clips) = decode_page(&reply, 0).unwrap();
        assert_eq!(total, 0);
        assert!(clips.is_empty());
    }
}
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd src-tauri && cargo test --lib tools::arrangement 2>&1 | tee ../.logs/t3-red.log; grep -n "cannot find function" ../.logs/t3-red.log | head -2
```

Expected: `cannot find function 'decode_page'`.

- [ ] **Step 4: Write the types and the decoder**

Above the test module in `src-tauri/src/tools/arrangement.rs`:

```rust
use crate::osc::query::LiveQuery;
use crate::tools::fence::fence;
use rosc::OscType;
use serde::Serialize;
use std::sync::Arc;
use std::time::Duration;

/// Deliberately equal to `clips::QUERY_TIMEOUT` and for the same reason: the
/// poll loop calls `RequestTable::expire` on that window every tick and
/// expiry drops the waiter, so a longer timeout here could never be reached.
pub const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

/// Clips asked for per page. The handler cuts the window down to what fits a
/// datagram, so this is an upper bound, not a promise.
pub const REQUEST_SPAN: usize = 48;

/// Round trips one track's timeline may cost before the read gives up.
/// Bounded so a Live that is not answering costs a fixed number of requests
/// rather than an unbounded sweep.
pub const MAX_WINDOWS: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArrangementClip {
    /// Position in the track's `arrangement_clips` list, and exactly what
    /// `get_arrangement_notes` takes. Not a bar number and not a slot.
    pub index: i32,
    pub name: String,
    pub start: f32,
    pub length: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TrackArrangement {
    pub track: i32,
    /// Empty means the track genuinely has nothing on the timeline, which is
    /// the normal state early in the writing phase. Never "we could not read
    /// it" -- that is what `ArrangementMap::missing` says.
    pub clips: Vec<ArrangementClip>,
    /// The read stopped before the track's real clip count was reached.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ArrangementMap {
    pub tracks: Vec<TrackArrangement>,
    /// Asked, no usable answer. Named rather than dropped: a silently short
    /// list reads as "those tracks are empty", which is the wrong answer
    /// rather than a missing one.
    pub missing: Vec<i32>,
}

/// `(track, start, total, *(name, start_time, length))`.
///
/// Returns `(start, total, clips)` with each clip's index already resolved
/// from the page offset, or `None` if the reply is not the page that was
/// asked for or does not decode cleanly. Fails closed on a ragged triple:
/// guessing which field is missing would invent a timeline, and the model
/// sends these indices back to read notes.
fn decode_page(reply: &[OscType], expect_start: usize) -> Option<(usize, usize, Vec<ArrangementClip>)> {
    let int_at = |i: usize| match reply.get(i)? {
        OscType::Int(v) => Some(*v),
        _ => None,
    };
    let start = usize::try_from(int_at(1)?).ok()?;
    if start != expect_start {
        return None;
    }
    let total = usize::try_from(int_at(2)?).ok()?;

    let fields = reply.get(3..)?;
    if fields.len() % 3 != 0 {
        return None;
    }
    let mut clips = Vec::with_capacity(fields.len() / 3);
    for (offset, triple) in fields.chunks_exact(3).enumerate() {
        let name = match &triple[0] {
            OscType::String(s) => fence(s),
            _ => return None,
        };
        let number = |arg: &OscType| match arg {
            OscType::Float(v) => Some(*v),
            OscType::Int(v) => Some(*v as f32),
            _ => None,
        };
        clips.push(ArrangementClip {
            index: (start + offset) as i32,
            name,
            start: number(&triple[1])?,
            length: number(&triple[2])?,
        });
    }
    Some((start, total, clips))
}
```

- [ ] **Step 5: Run the decoder tests**

```bash
cd src-tauri && cargo test --lib tools::arrangement 2>&1 | tee ../.logs/t3-green.log; grep -n "test result" ../.logs/t3-green.log
```

Expected: `ok. 4 passed`.

- [ ] **Step 6: Write the failing fan-out tests**

Add to the test module. This harness is `clips.rs`'s, adapted to one paged
address.

```rust
    use crate::osc::requests::RequestTable;
    use crate::osc::socket::OscSocket;
    use std::sync::Mutex;

    /// `timelines[i]` is track i's clips as (name, start, length). `silent`
    /// names tracks that get no reply at all, which is what a lost datagram
    /// looks like from the client's side. `page` is how many records the
    /// fake returns per reply, so a track longer than one page exercises the
    /// paging loop.
    #[derive(Default)]
    struct FakeLive {
        timelines: Vec<Vec<(String, f32, f32)>>,
        silent: Vec<i32>,
        page: usize,
        hold_until_all_arrive: Option<usize>,
    }

    async fn fake_live(fake: FakeLive) -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let page = if fake.page == 0 { REQUEST_SPAN } else { fake.page };
            let mut held: Vec<Vec<OscType>> = Vec::new();
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                if req.addr != "/live/mixingpal/get/arrangement" {
                    continue;
                }
                let (track, start) = match (req.args.first(), req.args.get(1)) {
                    (Some(OscType::Int(t)), Some(OscType::Int(s))) => (*t, *s as usize),
                    _ => continue,
                };
                if fake.silent.contains(&track) {
                    continue; // the reply Live could not send
                }
                let empty: Vec<(String, f32, f32)> = Vec::new();
                let timeline = fake.timelines.get(track as usize).unwrap_or(&empty);
                let mut reply = vec![
                    OscType::Int(track),
                    OscType::Int(start as i32),
                    OscType::Int(timeline.len() as i32),
                ];
                for (name, at, len) in timeline.iter().skip(start).take(page) {
                    reply.push(OscType::String(name.clone()));
                    reply.push(OscType::Float(*at));
                    reply.push(OscType::Float(*len));
                }
                if let Some(expect) = fake.hold_until_all_arrive {
                    held.push(reply);
                    if held.len() < expect {
                        continue; // answer nothing until every request is in
                    }
                    for reply in held.drain(..) {
                        let _ = live
                            .send_to(app_port, "/live/mixingpal/get/arrangement", reply)
                            .await;
                    }
                    continue;
                }
                let _ = live
                    .send_to(app_port, "/live/mixingpal/get/arrangement", reply)
                    .await;
            }
        });

        Arc::new(LiveQuery::new(app, table))
    }

    fn timeline(names: &[(&str, f32, f32)]) -> Vec<(String, f32, f32)> {
        names.iter().map(|(n, a, l)| ((*n).to_string(), *a, *l)).collect()
    }

    #[tokio::test]
    async fn every_track_request_goes_out_before_any_reply_is_awaited() {
        // The load-bearing performance claim: AbletonOSC serves all pending
        // requests inside one Live tick, so N in flight is one tick.
        let q = fake_live(FakeLive {
            timelines: vec![
                timeline(&[("Beat", 32.0, 64.0)]),
                timeline(&[("Sub", 32.0, 32.0)]),
                timeline(&[]),
            ],
            hold_until_all_arrive: Some(3),
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 3, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks.len(), 3);
        assert!(map.missing.is_empty());
    }

    #[tokio::test]
    async fn a_silent_track_is_named_in_missing_not_reported_empty() {
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&[("Beat", 0.0, 8.0)]), timeline(&[]), timeline(&[])],
            silent: vec![1],
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 3, Duration::from_millis(300)).await;
        assert_eq!(map.missing, vec![1]);
        assert_eq!(map.tracks.iter().map(|t| t.track).collect::<Vec<_>>(), vec![0, 2]);
    }

    #[tokio::test]
    async fn a_long_timeline_is_paged_until_the_total_is_reached() {
        let long: Vec<(&str, f32, f32)> =
            (0..10).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 3,
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert_eq!(map.tracks[0].clips.len(), 10);
        assert!(!map.tracks[0].truncated);
        // Indices are the timeline's own, continuous across page boundaries.
        assert_eq!(map.tracks[0].clips[9].index, 9);
    }

    #[tokio::test]
    async fn a_timeline_longer_than_the_window_budget_reports_truncated() {
        // MAX_WINDOWS round trips at one record each cannot reach the total.
        let long: Vec<(&str, f32, f32)> =
            (0..100).map(|_| ("Clip", 0.0, 4.0)).collect();
        let q = fake_live(FakeLive {
            timelines: vec![timeline(&long)],
            page: 1,
            ..Default::default()
        })
        .await;
        let map = get_arrangement(q, 1, QUERY_TIMEOUT).await;
        assert!(map.tracks[0].truncated);
        assert_eq!(map.tracks[0].clips.len(), MAX_WINDOWS);
        assert!(map.missing.is_empty(), "a truncated read is not a missing one");
    }
```

- [ ] **Step 7: Run to verify it fails**

```bash
cd src-tauri && cargo test --lib tools::arrangement 2>&1 | tee ../.logs/t3-fanout-red.log; grep -n "cannot find function .get_arrangement" ../.logs/t3-fanout-red.log
```

Expected: `cannot find function 'get_arrangement'`.

- [ ] **Step 8: Write the paging read and the fan-out**

Append below `decode_page`:

```rust
/// One track's whole timeline, paged.
///
/// `None` means the track did not answer at all, which is also how "there is
/// no track at that index" arrives: the handler returns None and sends
/// nothing, byte-identical to a lost datagram.
pub async fn read_track(q: &LiveQuery, track: i32, timeout: Duration) -> Option<TrackArrangement> {
    let mut clips: Vec<ArrangementClip> = Vec::new();
    let mut windows = 0usize;
    let mut truncated = false;

    loop {
        if windows >= MAX_WINDOWS {
            truncated = true;
            break;
        }
        windows += 1;

        let reply = q
            .query(
                "/live/mixingpal/get/arrangement",
                vec![
                    OscType::Int(track),
                    OscType::Int(clips.len() as i32),
                    OscType::Int(REQUEST_SPAN as i32),
                ],
                timeout,
            )
            .await
            .ok()?;

        let (_, total, page) = decode_page(&reply, clips.len())?;
        let empty_page = page.is_empty();
        clips.extend(page);

        if clips.len() >= total {
            break;
        }
        // A page that advanced nothing while the total says there is more
        // would loop until MAX_WINDOWS with no progress. Stop and say the
        // read is short rather than spending the budget on it.
        if empty_page {
            truncated = true;
            break;
        }
    }

    Some(TrackArrangement { track, clips, truncated })
}

/// Every track's timeline, all tracks concurrently.
///
/// Concurrency is the point, not an optimisation, and the reasoning is
/// `device_chains::get_device_chains`'s: `abletonosc/osc_server.py` drains
/// its socket until it blocks, so every pending request is served inside a
/// single Live tick (~100 ms). Each track pages independently inside its own
/// task, so a forty-track set costs one tick per page depth rather than one
/// per track.
///
/// Never returns `Err`. One track failing is one track's worth of missing
/// data, not a failed read of the set.
pub async fn get_arrangement(q: Arc<LiveQuery>, num_tracks: i32, timeout: Duration) -> ArrangementMap {
    let handles: Vec<_> = (0..num_tracks)
        .map(|track| {
            let q = q.clone();
            tokio::spawn(async move { read_track(&q, track, timeout).await })
        })
        .collect();

    let mut tracks = Vec::new();
    let mut missing = Vec::new();
    for (index, handle) in handles.into_iter().enumerate() {
        match handle.await {
            Ok(Some(entry)) => tracks.push(entry),
            _ => missing.push(index as i32),
        }
    }
    ArrangementMap { tracks, missing }
}
```

Register the module: add `pub mod arrangement;` to the alphabetical list at the
top of `src-tauri/src/tools/mod.rs`, before `pub mod clip_notes;`.

- [ ] **Step 9: Run the whole Rust suite**

```bash
cd src-tauri && cargo test 2>&1 | tee ../.logs/t3-full.log; grep -E "test result|^error" ../.logs/t3-full.log | head -4
```

Expected: all `ok`, including `osc::arity` and `a_tool_reply_never_lands_in_the_mirror`.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/src/tools/arrangement.rs src-tauri/src/tools/mod.rs \
        src-tauri/src/osc/arity.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Read every track's timeline, paged and concurrent

One task per track, each paging its own timeline, so a forty-track set costs
one Live tick per page depth rather than one per track. A track that never
answers is named in missing rather than reported empty, because an empty
timeline is the normal state early in the writing phase and the two must
stay distinguishable. The address is in both lib.rs lists from the start:
get_clips shipped missing them.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Offer `get_arrangement` to the model

**Files:**
- Modify: `src-tauri/src/tools/mod.rs` (schema entry, `arrangement_reasons`, `execute` arm, tests)
- Modify: `src-tauri/src/model.rs` (`SYSTEM_PROMPT`)
- Modify: `src/digest/build.ts` (pointer sentence)
- Test: `src-tauri/src/tools/mod.rs`, `src/digest/build.test.ts`

**Interfaces:**
- Consumes: `arrangement::{get_arrangement, ArrangementMap, QUERY_TIMEOUT}`; existing `track_count`, `track_identity`, `chains_moved`, `MAX_FANOUT_TRACKS`, `ToolResult::{live, missing}`.
- Produces: the tool name `get_arrangement` in `tool_schema()`; `fn arrangement_reasons(num_tracks: i64, read_tracks: i64, missing: &[i32], truncated: &[i32]) -> Option<String>`.

The three tripwires make this one task rather than three: adding the schema
entry fails `every_tool_in_the_schema_is_named_in_the_system_prompt` in
`model.rs` and the digest pointer test in `toolPointer.test.ts` until the
prompt and `build.ts` are updated in the same change.

- [ ] **Step 1: Write the failing tests**

Add to `mod.rs`'s test module:

```rust
    #[test]
    fn the_schema_offers_get_arrangement_with_no_arguments() {
        let tool = tool_schema()
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["function"]["name"] == "get_arrangement")
            .cloned()
            .expect("get_arrangement is in the schema");
        assert_eq!(tool["function"]["parameters"]["required"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn arrangement_reasons_names_every_partial_read_at_once() {
        let reason = arrangement_reasons(600, 512, &[3], &[7]).unwrap();
        assert!(reason.contains("truncated_to_first_512_tracks"));
        assert!(reason.contains("no_reply_for_tracks: 3"));
        assert!(reason.contains("timeline_truncated_for_tracks: 7"));
    }

    #[test]
    fn a_clean_arrangement_read_has_no_reason_at_all() {
        assert_eq!(arrangement_reasons(4, 4, &[], &[]), None);
    }

    #[tokio::test]
    async fn get_arrangement_without_a_track_count_says_so() {
        let ctx = disconnected_ctx(one_track_mirror());
        let r = execute(&ctx, "get_arrangement", &json!({})).await;
        assert_eq!(r.missing_reason.as_deref(), Some("not_in_mirror"));
    }
```

Update the existing tool-count test, which currently pins six:

```rust
    #[test]
    fn the_schema_lists_exactly_the_seven_tools_the_model_may_call() {
        // Renamed from six. get_arrangement is the seventh.
```

and add `"get_arrangement"` to its expected list.

- [ ] **Step 2: Run to verify they fail**

```bash
cd src-tauri && cargo test --lib 2>&1 | tee ../.logs/t4-red.log; grep -nE "cannot find function .arrangement_reasons|is in the schema" ../.logs/t4-red.log | head -2
```

Expected: a compile error for `arrangement_reasons`, then a panic on
`get_arrangement is in the schema`.

- [ ] **Step 3: Add the schema entry**

In `tool_schema()`, after the `get_clips` entry:

```rust
        {
            "type": "function",
            "function": {
                "name": "get_arrangement",
                "description": "Every track's arrangement timeline: for each clip, its index, name, start time in beats, and length in beats. Queried from Live at call time; one round trip per track covers the set, so calling it is cheap. The context block's SECTIONS line names the producer's locators and their positions, but says nothing about what plays in them - this is how to find out. A track with an empty list genuinely has nothing on the timeline, which is normal early in a writing session. Session-view clips are not covered; use get_clips for those, and their slot indices are different numbers from these. Use the index reported here with get_arrangement_notes to read a clip's notes. Tracks that did not answer are listed separately under missing, and a track whose timeline was too long to read in full is marked truncated.",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
```

- [ ] **Step 4: Add `arrangement_reasons`**

Below `clip_map_reasons` in `mod.rs`:

```rust
/// Assembles `get_arrangement`'s `missing_reason` from the three things that
/// can go partly wrong: a set larger than the fan-out cap, tracks that did not
/// answer, and tracks whose timeline was longer than the paging budget.
///
/// All three can hold at once, so they are joined rather than one overwriting
/// another. Extracted from the `execute` arm for the same reason
/// `chain_map_reasons` and `clip_map_reasons` were: inline, the truncation
/// case would have no test.
fn arrangement_reasons(
    num_tracks: i64,
    read_tracks: i64,
    missing: &[i32],
    truncated: &[i32],
) -> Option<String> {
    let mut reasons: Vec<String> = Vec::new();
    if num_tracks > read_tracks {
        reasons.push(format!(
            "truncated_to_first_{read_tracks}_tracks: the set has {num_tracks}"
        ));
    }
    if !missing.is_empty() {
        let names: Vec<String> = missing.iter().map(|t| t.to_string()).collect();
        reasons.push(format!("no_reply_for_tracks: {}", names.join(", ")));
    }
    if !truncated.is_empty() {
        let names: Vec<String> = truncated.iter().map(|t| t.to_string()).collect();
        reasons.push(format!(
            "timeline_truncated_for_tracks: {} (the clips listed are real, but the timeline continues past them)",
            names.join(", ")
        ));
    }
    (!reasons.is_empty()).then(|| reasons.join("; "))
}
```

- [ ] **Step 5: Add the `execute` arm**

In `execute`'s `match`, after the `get_clips` arm:

```rust
        "get_arrangement" => {
            // Without a count there is nothing to iterate. Querying 0..0
            // would return an empty map, which reads as "the set has no
            // arrangement" -- an invented answer, not a missing one.
            let Some(num_tracks) = track_count(&ctx.coalescer).filter(|n| *n >= 0) else {
                return ToolResult::missing("not_in_mirror");
            };
            let read_tracks = num_tracks.min(MAX_FANOUT_TRACKS);
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            // Same bracket as the chain map and the clip map: a same-count
            // reorder would leave these track indices naming another track's
            // timeline, and the answer would go back looking whole.
            let before: Vec<Option<serde_json::Value>> =
                (0..read_tracks).map(|t| track_identity(&ctx.coalescer, t)).collect();

            let map = arrangement::get_arrangement(
                query,
                read_tracks as i32,
                arrangement::QUERY_TIMEOUT,
            )
            .await;

            let after_count = track_count(&ctx.coalescer);
            let after: Vec<Option<serde_json::Value>> =
                (0..read_tracks).map(|t| track_identity(&ctx.coalescer, t)).collect();
            if chains_moved(num_tracks, after_count, &before, &after) {
                return ToolResult::missing("topology_changed");
            }

            let truncated: Vec<i32> =
                map.tracks.iter().filter(|t| t.truncated).map(|t| t.track).collect();
            let missing_reason =
                arrangement_reasons(num_tracks, read_tracks, &map.missing, &truncated);
            ToolResult::live(
                json!({ "tracks": map.tracks, "missing": map.missing }),
                missing_reason,
            )
        }
```

- [ ] **Step 6: Name the tool in the prompt**

In `src-tauri/src/model.rs`, add to `SYSTEM_PROMPT` under "How to work:",
after the clip bullet, following the file's trailing-backslash continuation
style exactly:

```
- The SECTIONS line names the producer's locators and where they are, and \
that is all the context block says about the timeline. For what actually \
plays where - which tracks are in a section, where the arrangement thins \
out, what drops at the drop - call get_arrangement. Arrangement clip \
indices and session slot indices are different numbers: an index from \
get_arrangement is never a slot for get_clip_notes.
```

Name ONLY `get_arrangement` here. The tripwire
`every_tool_named_in_the_system_prompt_exists_in_the_schema` runs in the
other direction too, so mentioning `get_arrangement_notes` before Task 5
adds it to the schema fails this task's own test run. Task 5 extends this
bullet.

- [ ] **Step 7: Name the tool in the digest pointer sentence**

In `src/digest/build.ts`, extend the closing sentence:

```ts
      "get_device_chains; for what is inside a Rack use get_rack_contents; " +
      "for what plays where on the timeline use get_arrangement; " +
      "for one device's parameter values use get_device_params.",
```

`get_arrangement_notes` is added to this sentence in Task 5, in the same
change that puts it in the schema. Keeping each task's prompt, schema and
digest consistent with each other is what lets every task's test run pass on
its own.

- [ ] **Step 8: Run everything**

```bash
cd src-tauri && cargo test 2>&1 | tee ../.logs/t4-cargo.log; grep -E "test result|^error" ../.logs/t4-cargo.log | head -3
cd .. && npx vitest run 2>&1 | tee .logs/t4-vitest.log; grep -E "PASS|FAIL" .logs/t4-vitest.log | tail -1
```

Expected: both green. `build.test.ts` may pin the old sentence; updating its
expected string is part of this task.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/tools/mod.rs src-tauri/src/model.rs src/digest/build.ts src/digest/build.test.ts
git commit -m "$(cat <<'EOF'
Offer get_arrangement to the model

Schema, dispatch, prompt and digest pointer move together because the
tripwires make them one change: a schema tool the prompt does not name, or
the digest sentence does not list, fails a test in the same commit.

The arm reuses the chain map's cap and topology bracket, and reports a
truncated timeline as a named partial rather than a short list, because a
short list reads as a finished arrangement.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `get_arrangement_notes`, guarded by an identity bracket

**Files:**
- Modify: `src-tauri/src/tools/clip_notes.rs` (parameterise the address family)
- Modify: `src-tauri/src/tools/arrangement.rs` (identity read, bracketed note read)
- Modify: `src-tauri/src/tools/mod.rs` (schema entry, `execute` arm, tests)
- Modify: `src-tauri/src/model.rs` (prompt already names it from Task 4 step 6)
- Modify: `src-tauri/src/osc/arity.rs`, `src-tauri/src/lib.rs` (three addresses, three lists)
- Test: `src-tauri/src/tools/arrangement.rs`, `src-tauri/src/tools/mod.rs`

**Interfaces:**
- Consumes: `clip_notes::{ClipNotes, Note}`, `arrangement::read_track`.
- Produces: `pub struct NoteAddresses { pub length: &'static str, pub num_notes: &'static str, pub notes_window: &'static str }`, `pub const SESSION_NOTES: NoteAddresses`, `pub const ARRANGEMENT_NOTES: NoteAddresses`, `pub async fn get_notes_at(q: Arc<LiveQuery>, addrs: NoteAddresses, track: i32, clip: i32, timeout: Duration) -> Result<ClipNotes, QueryError>` (the renamed body of the old `get_clip_notes`), and
  `pub async fn get_arrangement_notes(q: Arc<LiveQuery>, track: i32, index: i32, timeout: Duration) -> Result<ClipNotes, ArrangementNotesError>` where
  `pub enum ArrangementNotesError { Query(QueryError), IdentityChanged }`.

- [ ] **Step 1: Add the three arity entries and the three address lists**

In `src-tauri/src/osc/arity.rs`:

```rust
        | "/live/arrangement_clip/get/length"
        | "/live/arrangement_clip/get/num_notes"     => KeyArity::Args(2),   // in the existing Args(2) arm

        "/live/arrangement_clip/get/notes_window"                            // in the existing Args(3) arm
```

Add all three to the arity test's case table. Then add all three to
`is_resolve_only`, `POLL_LOOP_SENT_ADDRESSES`, and `TOOL_ONLY_REPLY_ADDRESSES`
in `src-tauri/src/lib.rs`.

- [ ] **Step 2: Write the failing identity-bracket test**

Add to `arrangement.rs`'s test module:

```rust
    #[tokio::test]
    async fn notes_are_dropped_when_the_clip_moved_during_the_read() {
        // Arrangement indices shift when a clip is added earlier in the
        // timeline. Without this, a read taken across that edit returns a
        // neighbour's notes as if they were the asked-for clip's -- the
        // failure the bracket exists to prevent, and one the model cannot
        // detect for itself.
        let q = fake_live_with_moving_clip().await;
        let err = get_arrangement_notes(q, 0, 0, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(matches!(err, ArrangementNotesError::IdentityChanged));
    }
```

with this harness beside the existing `fake_live`:

```rust
    /// Answers the identity read with one name the first time and a
    /// different one afterwards, which is what a clip inserted earlier in
    /// the timeline looks like from the client's side.
    async fn fake_live_with_moving_clip() -> Arc<LiveQuery> {
        let live = OscSocket::bind_to(0, 0).await.unwrap();
        let app = Arc::new(OscSocket::bind_to(0, live.local_port()).await.unwrap());
        let app_port = app.local_port();
        let table = Arc::new(Mutex::new(RequestTable::new()));

        let recv_socket = app.clone();
        let recv_table = table.clone();
        tokio::spawn(async move {
            loop {
                if let Ok(msg) = recv_socket.recv().await {
                    if let Ok(mut t) = recv_table.lock() {
                        t.resolve(&msg);
                    }
                }
            }
        });

        tokio::spawn(async move {
            let mut seen_identity = 0;
            loop {
                let req = match live.recv().await {
                    Ok(r) => r,
                    Err(_) => continue,
                };
                match req.addr.as_str() {
                    "/live/mixingpal/get/arrangement" => {
                        seen_identity += 1;
                        let name = if seen_identity == 1 { "Verse" } else { "Chorus" };
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![
                                    OscType::Int(0),
                                    OscType::Int(0),
                                    OscType::Int(1),
                                    OscType::String(name.into()),
                                    OscType::Float(32.0),
                                    OscType::Float(8.0),
                                ],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/length" => {
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![req.args[0].clone(), req.args[1].clone(), OscType::Float(8.0)],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/num_notes" => {
                        let _ = live
                            .send_to(
                                app_port,
                                &req.addr,
                                vec![req.args[0].clone(), req.args[1].clone(), OscType::Int(1)],
                            )
                            .await;
                    }
                    "/live/arrangement_clip/get/notes_window" => {
                        let mut reply = vec![
                            req.args[0].clone(),
                            req.args[1].clone(),
                            req.args[2].clone(),
                        ];
                        reply.extend(vec![
                            OscType::Int(60),
                            OscType::Float(0.0),
                            OscType::Float(0.5),
                            OscType::Float(100.0),
                            OscType::Bool(false),
                        ]);
                        let _ = live.send_to(app_port, &req.addr, reply).await;
                    }
                    _ => {}
                }
            }
        });

        Arc::new(LiveQuery::new(app, table))
    }
```

- [ ] **Step 3: Run to verify it fails**

```bash
cd src-tauri && cargo test --lib tools::arrangement 2>&1 | tee ../.logs/t5-red.log; grep -n "cannot find" ../.logs/t5-red.log | head -2
```

Expected: `cannot find function 'get_arrangement_notes'` and
`cannot find type 'ArrangementNotesError'`.

- [ ] **Step 4: Parameterise the note addresses in `clip_notes.rs`**

Add near the top of `src-tauri/src/tools/clip_notes.rs`:

```rust
/// The three addresses one note read uses.
///
/// Session and arrangement clips are different objects in Live and are
/// reached by different address families, but the reply shapes are identical
/// by construction (`mixingpal/clip_replies.py` builds both), so everything
/// below this line -- the decoder, the window halving, the retry budget --
/// is shared rather than copied. Copying it was the alternative, and this is
/// the most delicate code in the app.
#[derive(Debug, Clone, Copy)]
pub struct NoteAddresses {
    pub length: &'static str,
    pub num_notes: &'static str,
    pub notes_window: &'static str,
}

pub const SESSION_NOTES: NoteAddresses = NoteAddresses {
    length: "/live/clip/get/length",
    num_notes: "/live/clip/get/num_notes",
    notes_window: "/live/clip/get/notes_window",
};

pub const ARRANGEMENT_NOTES: NoteAddresses = NoteAddresses {
    length: "/live/arrangement_clip/get/length",
    num_notes: "/live/arrangement_clip/get/num_notes",
    notes_window: "/live/arrangement_clip/get/notes_window",
};
```

Rename the existing `get_clip_notes` to `get_notes_at`, add an
`addrs: NoteAddresses` parameter, and replace each of its three hard-coded
address literals (currently at roughly `:230`, `:236`, `:300`) with
`addrs.length`, `addrs.num_notes`, and `addrs.notes_window`. Then keep the old
name as a thin wrapper so no existing caller or test changes:

```rust
/// Session-view clip notes. The shape the app has always had; the address
/// family is now explicit so the arrangement read can share everything else.
pub async fn get_clip_notes(
    q: Arc<LiveQuery>,
    track: i32,
    clip: i32,
    timeout: Duration,
) -> Result<ClipNotes, QueryError> {
    get_notes_at(q, SESSION_NOTES, track, clip, timeout).await
}
```

- [ ] **Step 5: Write the bracketed arrangement read**

Append to `src-tauri/src/tools/arrangement.rs`:

```rust
use crate::osc::query::QueryError;
use crate::tools::clip_notes::{self, ClipNotes, ARRANGEMENT_NOTES};

#[derive(Debug)]
pub enum ArrangementNotesError {
    Query(QueryError),
    /// The clip at this index was not the same clip before and after the
    /// read. Its notes are dropped rather than returned under the wrong name.
    IdentityChanged,
}

/// One arrangement clip's identity: what makes "index 3" a particular clip
/// rather than a position.
async fn identity_of(
    q: &LiveQuery,
    track: i32,
    index: i32,
    timeout: Duration,
) -> Option<(String, f32, f32)> {
    let reply = q
        .query(
            "/live/mixingpal/get/arrangement",
            vec![OscType::Int(track), OscType::Int(index), OscType::Int(1)],
            timeout,
        )
        .await
        .ok()?;
    let (_, _, clips) = decode_page(&reply, index as usize)?;
    let clip = clips.first()?;
    Some((clip.name.clone(), clip.start, clip.length))
}

/// Notes in one arrangement clip, bracketed by an identity check.
///
/// The bracket is not defence in depth, it is the guard. Arrangement indices
/// shift when a clip is added earlier in the timeline, so a read spanning
/// that edit lands on a neighbour and returns real notes under the wrong
/// clip's name -- a confident, wrong answer, and one the model has no way to
/// detect. Checking in Rust rather than echoing the identity and hoping the
/// model compares it is the pattern `device_params` and `rack_contents`
/// already use.
pub async fn get_arrangement_notes(
    q: Arc<LiveQuery>,
    track: i32,
    index: i32,
    timeout: Duration,
) -> Result<ClipNotes, ArrangementNotesError> {
    let before = identity_of(&q, track, index, timeout)
        .await
        .ok_or(ArrangementNotesError::Query(QueryError::NoReply))?;

    let notes = clip_notes::get_notes_at(q.clone(), ARRANGEMENT_NOTES, track, index, timeout)
        .await
        .map_err(ArrangementNotesError::Query)?;

    let after = identity_of(&q, track, index, timeout)
        .await
        .ok_or(ArrangementNotesError::Query(QueryError::NoReply))?;

    if before != after {
        return Err(ArrangementNotesError::IdentityChanged);
    }
    Ok(notes)
}
```

- [ ] **Step 6: Run the bracket test**

```bash
cd src-tauri && cargo test --lib tools::arrangement 2>&1 | tee ../.logs/t5-green.log; grep -n "test result" ../.logs/t5-green.log
```

Expected: `ok`.

- [ ] **Step 7: Add the schema entry and the dispatch arm**

Schema, after `get_arrangement`:

```rust
        {
            "type": "function",
            "function": {
                "name": "get_arrangement_notes",
                "description": "Every MIDI note in one arrangement-view clip, as pitch, start, duration, velocity, mute. Queried from Live at call time and fetched in pages. The index comes from get_arrangement and is that clip's position on the track's timeline - it is NOT a session slot index, and get_clip_notes will not accept it. The read is bracketed by an identity check: if the clip at that index changed while it was being read, which happens when a clip is added earlier in the timeline, the notes are refused rather than returned under the wrong clip's name. An audio clip has no notes to read.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "track": { "type": "integer", "description": "Zero-based track index." },
                        "index": { "type": "integer", "description": "The clip's position in that track's arrangement, as reported by get_arrangement." }
                    },
                    "required": ["track", "index"]
                }
            }
        },
```

`execute` arm, after `get_arrangement`:

```rust
        "get_arrangement_notes" => {
            let (Some(track), Some(index)) = (
                int_arg(args, "track").filter(|t| *t >= 0),
                int_arg(args, "index").filter(|i| *i >= 0),
            ) else {
                return ToolResult::missing("bad_arguments");
            };
            let query = match ctx.query.lock() {
                Ok(q) => q.clone(),
                Err(_) => return ToolResult::missing("mirror_unavailable"),
            };
            let Some(query) = query else {
                return ToolResult::missing("not_connected");
            };

            match arrangement::get_arrangement_notes(
                query,
                track as i32,
                index as i32,
                arrangement::QUERY_TIMEOUT,
            )
            .await
            {
                Ok(notes) => ToolResult::live(
                    json!({ "notes": notes.notes, "count": notes.notes.len() }),
                    notes.missing_reason,
                ),
                Err(arrangement::ArrangementNotesError::IdentityChanged) => {
                    ToolResult::missing("arrangement_clip_identity_changed")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::NoReply)) => {
                    ToolResult::missing("no_reply")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::Busy)) => {
                    ToolResult::missing("busy")
                }
                Err(arrangement::ArrangementNotesError::Query(QueryError::Transport(e))) => {
                    ToolResult::missing(&format!("transport_error: {e}"))
                }
            }
        }
```

Update the tool-count test again, from seven to eight, and add
`"get_arrangement_notes"` to its list.

Then extend the two places Task 4 deliberately left alone, in this same
commit, because the tripwires bind all three together:

- `SYSTEM_PROMPT`'s arrangement bullet, appending after "call get_arrangement":
  `, and then get_arrangement_notes on the few clips that matter`.
- `src/digest/build.ts`'s pointer sentence, adding
  `for the notes in a timeline clip use get_arrangement_notes; ` before the
  `get_device_params` clause. Update `build.test.ts`'s expected string with it.

- [ ] **Step 8: Run everything**

```bash
cd src-tauri && cargo test 2>&1 | tee ../.logs/t5-full.log; grep -E "test result|^error" ../.logs/t5-full.log | head -3
cd .. && npx vitest run 2>&1 | tee .logs/t5-vitest.log; grep -E "PASS|FAIL" .logs/t5-vitest.log | tail -1
```

Expected: both green, including the prompt and digest tripwires, which the
Task 4 prompt bullet and pointer sentence already satisfy.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/tools/arrangement.rs src-tauri/src/tools/clip_notes.rs \
        src-tauri/src/tools/mod.rs src-tauri/src/osc/arity.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
Read an arrangement clip's notes, refusing a moved clip

The address family is now a parameter, so the arrangement read shares the
decoder, the window halving and the retry budget rather than copying the
most delicate code in the app.

Arrangement indices shift when a clip is added earlier in the timeline, so
the read is bracketed by an identity check and the notes are dropped if the
clip moved. Echoing the identity and expecting the model to compare it was
the alternative; device_params and rack_contents both check in Rust, and a
wrong answer here reads as a completely ordinary one.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Section names in the context block

**Files:**
- Modify: `src-tauri/src/osc/arity.rs`, `src-tauri/src/osc/pollers.rs`, `src-tauri/src/lib.rs`
- Modify: `shared/handled-addresses.json`
- Modify: `src/live/model.ts`, `src/live/apply.ts`, `src/live/addresses.test.ts`
- Modify: `src/digest/build.ts`
- Test: `src-tauri/src/lib.rs`, `src/live/apply.test.ts`, `src/digest/build.test.ts`

**Interfaces:**
- Consumes: `SetState` from `src/live/model.ts`; `applyDelta`; `buildContext`.
- Produces: `PollKind::CuePoints`; `export interface CuePoint { name: string; time: number }`; `SetState.cuePoints: CuePoint[]`; a `SECTIONS (beats)` line in `buildContext`'s output.

Unlike every other new address in this plan, cue points are **not**
resolve-only: they are mirrored on purpose, because the digest reads them from
`SetState` on every turn. Do not add this address to `is_resolve_only`. Do add
it to `POLL_LOOP_SENT_ADDRESSES`.

- [ ] **Step 1: Write the failing TypeScript tests**

Add to `src/digest/build.test.ts`:

```ts
  it("names the producer's sections, fenced, with the unit", () => {
    // A bare "«Verse» 32" leaves the model to guess bars or beats, and it
    // will guess wrong against a producer reading bars off Live's ruler.
    const state = { ...emptySet(), cuePoints: [
      { name: "Intro", time: 0 },
      { name: "Drop", time: 64 },
    ] };
    const out = buildContext(state, "");
    expect(out).toContain("SECTIONS (beats)");
    expect(out).toContain("«Intro» 0");
    expect(out).toContain("«Drop» 64");
  });

  it("omits the sections line entirely when the set has no locators", () => {
    // An empty "SECTIONS" line would read as "this set has no structure"
    // rather than "nobody dropped a locator".
    const out = buildContext({ ...emptySet(), cuePoints: [] }, "");
    expect(out).not.toContain("SECTIONS");
  });
```

and to `src/live/apply.test.ts`:

```ts
  it("maps a cue point reply into pairs", () => {
    const state = applyDelta(emptySet(), {
      addr: "/live/song/get/cue_points",
      args: ["Intro", 0, "Drop", 64],
    });
    expect(state.cuePoints).toEqual([
      { name: "Intro", time: 0 },
      { name: "Drop", time: 64 },
    ]);
  });

  it("ignores a ragged cue point reply rather than half-applying it", () => {
    // A trailing name with no time would misplace every section after it.
    const before = { ...emptySet(), cuePoints: [{ name: "Intro", time: 0 }] };
    const after = applyDelta(before, {
      addr: "/live/song/get/cue_points",
      args: ["Intro", 0, "Drop"],
    });
    expect(after.cuePoints).toEqual(before.cuePoints);
  });
```

- [ ] **Step 2: Run to verify they fail**

```bash
npx vitest run src/digest src/live 2>&1 | tee .logs/t6-red.log; grep -nE "SECTIONS|cuePoints" .logs/t6-red.log | head -3
```

Expected: failures on the missing `SECTIONS` line and on `cuePoints` being
undefined.

- [ ] **Step 3: Add the type and the state field**

In `src/live/model.ts`:

```ts
/// One of the producer's locators: a name and its position in beats.
export interface CuePoint {
  name: string;
  time: number;
}
```

Add `cuePoints: CuePoint[];` to `SetState`, and `cuePoints: []` to whatever
constructs an empty set (`emptySet()` in `src/live/apply.ts`).

- [ ] **Step 4: Decode the reply in `applyDelta`**

In `src/live/apply.ts`, above the `SONG_FIELDS` lookup, beside the
`NUM_TRACKS_ADDR` case:

```ts
// Handled directly rather than through SONG_FIELDS for the same reason
// NUM_TRACKS_ADDR is: the reply is a flat (name, time, name, time, ...)
// list, not a single value to copy into one field.
export const CUE_POINTS_ADDR = "/live/song/get/cue_points";
```

and inside `applyDelta`:

```ts
  if (delta.addr === CUE_POINTS_ADDR) {
    // An odd-length reply is a half-decoded locator list, which would
    // misplace every section after the bad entry. Keep what we had.
    if (delta.args.length % 2 !== 0) return state;
    const cuePoints: CuePoint[] = [];
    for (let i = 0; i < delta.args.length; i += 2) {
      const name = delta.args[i];
      const time = delta.args[i + 1];
      if (typeof name !== "string" || typeof time !== "number") return state;
      cuePoints.push({ name, time });
    }
    return { ...state, cuePoints };
  }
```

Add `CUE_POINTS_ADDR` to `handledOutsideFieldMaps` in
`src/live/addresses.test.ts`, and `"/live/song/get/cue_points"` to
`songFields` in `shared/handled-addresses.json`.

- [ ] **Step 5: Render the line**

In `src/digest/build.ts`, after the `SET` line and before the `GOAL` line:

```ts
  if (state.cuePoints.length > 0) {
    const sections = state.cuePoints
      .map((c) => `${fence(c.name)} ${c.time}`)
      .join(", ");
    lines.push(`SECTIONS (beats)  ${sections}`);
  }
```

- [ ] **Step 6: Poll the address**

In `src-tauri/src/osc/arity.rs`, add `"/live/song/get/cue_points"` to the
`KeyArity::None` arm and to the test's case table.

In `src-tauri/src/osc/pollers.rs`, add `CuePoints` to the `PollKind` enum, to
`all()`, an `interval()` arm of `Duration::from_secs(5)` (locators change when
the producer drops one, which is rare), and an `order()` value of `6`.

In `src-tauri/src/lib.rs`, add a `PollKind::CuePoints` arm to the poll match
that calls `register_and_send(table, poll_socket, now, "/live/song/get/cue_points", vec![])`,
and add the address to `POLL_LOOP_SENT_ADDRESSES`. **Do not** add it to
`is_resolve_only`: this one is mirrored on purpose.

- [ ] **Step 7: Run everything**

```bash
npx vitest run 2>&1 | tee .logs/t6-vitest.log; grep -E "PASS|FAIL" .logs/t6-vitest.log | tail -1
cd src-tauri && cargo test 2>&1 | tee ../.logs/t6-cargo.log; grep -E "test result|^error" ../.logs/t6-cargo.log | head -3
cd .. && npm run build 2>&1 | tee .logs/t6-build.log; grep -c "error" .logs/t6-build.log
```

Expected: all green, `0` build errors. The address-consistency tripwires in
both languages pass only once the manifest and `handledOutsideFieldMaps` both
name the address.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/osc/arity.rs src-tauri/src/osc/pollers.rs src-tauri/src/lib.rs \
        shared/handled-addresses.json src/live/model.ts src/live/apply.ts \
        src/live/addresses.test.ts src/digest/build.ts \
        src/digest/build.test.ts src/live/apply.test.ts
git commit -m "$(cat <<'EOF'
Name the producer's sections in every context block

Cue points cannot be subscribed -- upstream registers the address as a plain
handler rather than through its property list, so there is no start_listen --
so they are polled at the cadence a rarely-changing value deserves.

The line carries its unit. A bare "«Verse» 32" leaves the model to guess
bars or beats against a producer reading bars off Live's ruler, and the
timeline reports beats everywhere else. A set with no locators omits the
line rather than printing an empty one that reads as "no structure".

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Evals and manual verification

**Files:**
- Modify: `shared/eval-set.json`, `shared/eval-context.txt`
- Modify: `src-tauri/tests/evals.rs`
- Modify: `docs/manual-verification.md`
- Test: `src-tauri/tests/evals.rs`, `src/digest/evalFixture.test.ts`

**Interfaces:**
- Consumes: the fixture shape from `shared/eval-set.json`; the fake in
  `tests/evals.rs`; `buildContext`.
- Produces: an `arrangement` array and a `cuePoints` array per the fixture; a
  new scenario `an_arrangement_question_reads_the_timeline_before_answering`.

- [ ] **Step 1: Extend the fixture**

In `shared/eval-set.json`, add to the `song` object:

```json
    "cuePoints": [
      { "name": "Intro", "time": 0 },
      { "name": "Drop", "time": 64 }
    ]
```

and give each track an `arrangement` array. Pad gets a gap in the middle,
which is what the scenario asks about:

```json
      "arrangement": [
        { "name": "Pad Intro", "start": 0.0, "length": 32.0 },
        { "name": "Pad Outro", "start": 96.0, "length": 32.0 }
      ]
```

Drums gets `[{ "name": "Beat", "start": 0.0, "length": 128.0 }]`, Vox gets
`[{ "name": "Take 3", "start": 64.0, "length": 32.0 }]`, and Bass keeps
`"silent": true` with an empty `arrangement`.

- [ ] **Step 2: Regenerate the pinned context block**

`src/digest/evalFixture.test.ts` fails until `shared/eval-context.txt` matches
what `buildContext` now renders, including the new `SECTIONS (beats)` line.
Regenerate it by any route (a throwaway vitest that writes the file, or by
hand from `build.ts`'s format), delete any throwaway script, and **read the
file before committing it.**

```bash
npx vitest run src/digest/evalFixture.test.ts 2>&1 | tee .logs/t7-pin.log; grep -nE "SECTIONS|FAIL|PASS" .logs/t7-pin.log | head -3
cat shared/eval-context.txt
```

- [ ] **Step 3: Teach the eval fake the arrangement address**

In `src-tauri/tests/evals.rs`, add an arm to the fake's address match, beside
the existing clip arms:

```rust
                "/live/mixingpal/get/arrangement" => {
                    let start = int_at(1).unwrap_or(0) as usize;
                    let span = int_at(2).unwrap_or(48) as usize;
                    let clips = track["arrangement"].as_array().cloned().unwrap_or_default();
                    let mut reply = vec![
                        OscType::Int(track_index),
                        OscType::Int(start as i32),
                        OscType::Int(clips.len() as i32),
                    ];
                    for clip in clips.iter().skip(start).take(span) {
                        reply.push(OscType::String(
                            clip["name"].as_str().unwrap().to_string(),
                        ));
                        reply.push(OscType::Float(clip["start"].as_f64().unwrap() as f32));
                        reply.push(OscType::Float(clip["length"].as_f64().unwrap() as f32));
                    }
                    let _ = live.send_to(app_port, &req.addr, reply).await;
                }
```

- [ ] **Step 4: Add the scenario**

```rust
#[tokio::test]
async fn an_arrangement_question_reads_the_timeline_before_answering() {
    // The gap this feature exists to close: with no timeline read, the model
    // answered structural questions from track names and session clips.
    let turn = ask("where is the arrangement thin?").await;
    assert!(!turn.truncated, "the turn ran out of round trips");
    assert!(
        turn.called.contains(&"get_arrangement".to_string()),
        "{:?}",
        turn.called
    );
    // The Pad has nothing between beat 32 and beat 96, and the SECTIONS line
    // puts «Drop» at 64, so a real answer can name the section or the beats.
    let a = lower(&turn.answer);
    assert!(
        a.contains("drop") || a.contains("pad") || a.contains("64"),
        "the answer should point at where the gap is: {}",
        turn.answer
    );
}
```

- [ ] **Step 5: Verify the gate and the compile**

```bash
cd src-tauri && cargo test 2>&1 | tee ../.logs/t7-gate.log; grep -c "evals" ../.logs/t7-gate.log
cargo test --features evals --test evals --no-run 2>&1 | tee ../.logs/t7-build.log; grep -nE "^error|Finished" ../.logs/t7-build.log | head -3
```

Expected: `0` (a plain `cargo test` must not build the eval target), then
`Finished` with no warnings.

**Do not run the suite against a real provider.** It costs the user's quota
and needs credentials this environment does not have.

- [ ] **Step 6: Write the manual verification section**

Add a `## Arrangement` section to `docs/manual-verification.md`, beside
`## Clips`, marked `Status: **PENDING-USER**`:

```markdown
## Arrangement

- [ ] `/live/song/get/cue_points` replies as flat `(name, time)` pairs, and a
      set with no locators replies with an empty list rather than not replying.
- [ ] The `SECTIONS (beats)` line matches Live's locators, and the positions
      are beats, not bars. Confirm against Live's ruler set to beats.
- [ ] `get_arrangement` reports clip indices that match the timeline order,
      and a track with nothing on the timeline reports an empty list rather
      than landing in `missing`.
- [ ] A track with hundreds of arrangement clips pages to completion, or
      reports `truncated` at the cap. It must not go silent.
- [ ] Read a clip with `get_arrangement_notes`, then add a clip earlier in the
      timeline and read the same index again: the second read must report
      `arrangement_clip_identity_changed` rather than a neighbour's notes.
- [ ] An audio arrangement clip: confirm `length` answers and `num_notes` does
      not, the same asymmetry the Clips section asks about for session clips.
- [ ] **Stale connector:** run a v4 script against a v5 app. Session, mixer
      and device reads keep working; the arrangement map and arrangement notes
      both report a named gap; the banner asks for a reinstall.
```

- [ ] **Step 7: Commit**

```bash
git add shared/eval-set.json shared/eval-context.txt src-tauri/tests/evals.rs \
        docs/manual-verification.md
git commit -m "$(cat <<'EOF'
Cover the arrangement in the evals and the manual checklist

The fixture's Pad now has a hole between beat 32 and beat 96 with «Drop» at
64, so "where is the arrangement thin?" has a real answer that requires
reading the timeline rather than the track names.

The manual section carries the checks no fixture can make: that positions
are beats rather than bars, that a long timeline pages instead of going
silent, and that the identity bracket fires when a clip is inserted earlier.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] `npm run test:script` — Python `OK`.
- [ ] `cd src-tauri && cargo test` — all `ok`, no eval target built.
- [ ] `npx vitest run` — all passed.
- [ ] `npm run build` — no TypeScript errors.
- [ ] `cargo test --features evals --test evals --no-run` — `Finished`, no warnings.
- [ ] `git diff main --stat -- shared/wire-version.json remote-script/MixingPal/mixingpal/version.py` — both moved to 5, and the Rust tripwire agrees.
