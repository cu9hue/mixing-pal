# Set Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every Live Set a stable identity the app can read: an id stored in the set, the set's path as the fallback, and its name alongside, as `setId`, `setPath`, and `setName` in `SetState`.

**Architecture:** The connector answers one new address, `/live/mixingpal/get/set_identity`, with three strings. The write decision is a pure Python module tested outside Live; the handler holds only the previous read, the try/excepts, and the read-back. Rust polls the address once a second, gated on a version reply of 12 or more, and mirrors it like the locators. The frontend decodes the three-arg reply directly and owns the id-else-path fallback. Wire version 12.

**Tech Stack:** Python 3 (Live's Remote Script runtime, unittest), Rust (Tauri core, tokio, cargo test), TypeScript (React frontend, vitest).

**Spec:** `docs/superpowers/specs/2026-09-07-set-identity-design.md`

## Global Constraints

- Wire version moves from 11 to 12 in exactly two places: `remote-script/MixingPal/mixingpal/version.py` (`WIRE_VERSION = 12`) and `shared/wire-version.json` (`{ "version": 12 }`). A Rust test parses the Python literal and asserts it equals the JSON.
- The only write to a set, ever: `song.set_data("mixingpal", {"set_id": <32 lowercase hex>})`, and only when `song.get_data("mixingpal", None)` returned `None` on two consecutive polls. A value under the key with no valid id is never written over.
- The new address is `KeyArity::None`, is in `EMITTED_ADDRESSES` and `POLL_LOOP_SENT_ADDRESSES`, is **not** in `is_resolve_only`, and is listed under `songFields` in `shared/handled-addresses.json`. Both address tripwires must be green at the end of Task 5.
- The identity poll sends nothing until the last `/live/mixingpal/get/version` reply is `>= 12`.
- Empty string on the wire means "none". The frontend maps it to `null`.
- Nothing in `src-tauri/src/tools/` or the system prompt reads the set's id, name, or path.
- No new Markdown files beyond this plan. The spike's record goes in `docs/manual-verification.md`.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit only named files. Never `git add -A`.
- Never print API keys. Do not set any `MIXINGPAL_EVAL_*` variable; the evals are paid.
- Pipe test output to a file under the scratchpad directory, then grep the file. The commands below write to `$SCRATCH`; set it to the session's scratchpad directory before running them.

---

### Task 1: The identity rules, pure and tested outside Live

**Files:**
- Create: `remote-script/MixingPal/mixingpal/set_identity_rules.py`
- Create: `remote-script/tests/test_set_identity_rules.py`

**Interfaces:**
- Produces: `KEY = "mixingpal"`, `UNREAD` (a sentinel object), `valid_id(value) -> str`, `decide(previous, current, generate) -> (report: str, write: dict | None)`. Task 2's handler imports all four.

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for mixingpal/set_identity_rules.py.

The module is loaded by file path rather than imported as
`mixingpal.set_identity_rules`, for the same reason `test_rack_paths.py`
does it: `mixingpal/__init__.py` imports every handler, and those reach
`ableton.v2.control_surface`, which exists only inside Live.

What these pin is the one write this connector ever makes to a set. Spec:
docs/superpowers/specs/2026-09-07-set-identity-design.md, "The value rule"
and "The write decision".

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "set_identity_rules.py")
_SPEC = importlib.util.spec_from_file_location("set_identity_rules", _TARGET)
rules = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rules)

VALID = "0123456789abcdef0123456789abcdef"


class ValidIdTests(unittest.TestCase):
    def test_a_dict_with_a_32_hex_set_id_is_that_id(self):
        self.assertEqual(rules.valid_id({"set_id": VALID}), VALID)

    def test_extra_keys_beside_set_id_do_not_invalidate_it(self):
        # A later version adds a field by adding a key and keeping set_id.
        self.assertEqual(rules.valid_id({"set_id": VALID, "note": "x"}), VALID)

    def test_none_is_no_id(self):
        self.assertEqual(rules.valid_id(None), "")

    def test_a_non_dict_is_no_id(self):
        self.assertEqual(rules.valid_id("abc"), "")
        self.assertEqual(rules.valid_id(["set_id", VALID]), "")

    def test_a_dict_without_set_id_is_no_id(self):
        self.assertEqual(rules.valid_id({}), "")
        self.assertEqual(rules.valid_id({"id": VALID}), "")

    def test_a_set_id_that_is_not_32_lowercase_hex_is_no_id(self):
        self.assertEqual(rules.valid_id({"set_id": VALID.upper()}), "")
        self.assertEqual(rules.valid_id({"set_id": VALID[:-1]}), "")
        self.assertEqual(rules.valid_id({"set_id": 42}), "")


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.calls = 0

        def generate():
            self.calls += 1
            return VALID

        self.generate = generate

    def test_a_valid_id_is_reported_and_nothing_is_written(self):
        report, write = rules.decide(None, {"set_id": VALID}, self.generate)
        self.assertEqual(report, VALID)
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_two_absent_reads_in_a_row_write_a_new_id(self):
        report, write = rules.decide(None, None, self.generate)
        self.assertEqual(report, "")
        self.assertEqual(write, {"set_id": VALID})
        self.assertEqual(self.calls, 1)

    def test_the_first_poll_never_writes(self):
        # No previous read yet: a transient default during a document load
        # is read once and left alone.
        report, write = rules.decide(rules.UNREAD, None, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_a_value_with_no_valid_id_is_never_written_over(self):
        foreign = {"other": 1}
        report, write = rules.decide(foreign, foreign, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        bad = {"set_id": "nope"}
        report, write = rules.decide(bad, bad, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_an_absent_read_after_a_foreign_one_does_not_write_yet(self):
        report, write = rules.decide({"other": 1}, None, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python3 -m unittest discover -s remote-script/tests -v 2>&1 | tee "$SCRATCH/py-task1-red.log" | tail -5`
Expected: an import error, because `set_identity_rules.py` does not exist.

- [ ] **Step 3: Write the module**

```python
"""The identity key's rules, kept out of the handler so they can be tested
outside Live: `set_identity.py` holds the OSC plumbing, this file holds the
logic that can be wrong, the way `rack.py` and `rack_paths.py` split.

Spec: docs/superpowers/specs/2026-09-07-set-identity-design.md. This is the
one write this connector ever makes to a set, and these two functions are
the whole decision.
"""
import re

KEY = "mixingpal"

# The handler's "previous read" before its first poll. Distinct from None,
# which is what get_data returns for an absent key.
UNREAD = object()

_HEX32 = re.compile(r"^[0-9a-f]{32}$")


def valid_id(value):
    """The value rule: the id in `value`, or "" when it holds none.

    `value` is what Song.get_data(KEY, None) returned. Extra keys beside
    "set_id" are ignored and, since a set with a valid id is never written
    to, never removed: that is how a later version adds a field without
    dropping every existing set into the path fallback.
    """
    if not isinstance(value, dict):
        return ""
    set_id = value.get("set_id")
    if isinstance(set_id, str) and _HEX32.match(set_id):
        return set_id
    return ""


def decide(previous, current, generate):
    """The write decision over two consecutive reads of the key.

    Returns (report, write): the id to report now, and the value to store
    with Song.set_data, or None. Only an absent key -- None on this read and
    on the previous one -- is ever written; a value under the key with no
    valid id is never repaired. The first poll has no previous read (UNREAD)
    and never writes, so a transient default during a document load is read
    once and left alone. `generate` is called only when a write is returned.

    After a write the caller reads the key back and reports valid_id() of
    that, never a value from here: a write that did not take reports "".
    """
    found = valid_id(current)
    if found:
        return found, None
    if current is None and previous is None:
        return "", {"set_id": generate()}
    return "", None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python3 -m unittest discover -s remote-script/tests -v 2>&1 | tee "$SCRATCH/py-task1.log" | tail -5`
Expected: `OK`, with the eleven new tests listed among the existing ones.

- [ ] **Step 5: Commit**

```bash
git add remote-script/MixingPal/mixingpal/set_identity_rules.py remote-script/tests/test_set_identity_rules.py
git commit -m "Add the set identity rules: the value rule and the write decision, tested outside Live

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The handler, the wire bump, and the read-only comment

**Files:**
- Create: `remote-script/MixingPal/mixingpal/set_identity.py`
- Modify: `remote-script/MixingPal/mixingpal/manager.py` (import list and the `self.handlers += [...]` list)
- Modify: `remote-script/MixingPal/mixingpal/__init__.py`
- Modify: `remote-script/MixingPal/mixingpal/version.py` (history comment and `WIRE_VERSION`)
- Modify: `shared/wire-version.json`
- Modify: `src-tauri/src/osc/socket.rs:12-17` (doc comment only)

**Interfaces:**
- Consumes: `KEY`, `UNREAD`, `decide`, `valid_id` from Task 1.
- Produces: the address `/live/mixingpal/get/set_identity`, reply `(stored_set_id: str, name: str, file_path: str)`, empty string meaning none. Tasks 4 and 5 consume it.

There is no automated test for the handler: it subclasses `AbletonOSCHandler`, whose base imports `ableton.v2`, which exists only inside Live. Its logic is three try/excepts and one remembered value; Task 3 exercises it in Live.

- [ ] **Step 1: Write the handler**

```python
import uuid
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .set_identity_rules import KEY, UNREAD, decide, valid_id


class SetIdentityHandler(AbletonOSCHandler):
    """Answers /live/mixingpal/get/set_identity with (stored_set_id, name,
    file_path), empty strings meaning none.

    The one write this connector ever makes to a set: the identity key,
    under the conditions in docs/superpowers/specs/2026-09-07-set-identity-
    design.md. The decision lives in set_identity_rules.py; this class holds
    the previous read, the try/excepts, and the read-back. Each of the three
    reads is guarded on its own, so one property raising never takes the
    other two down with it. Logs on change and on write only: the log
    rotates at 2 MB, and a line per poll would turn the spike's own evidence
    over in a day.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "mixingpal"
        # After super().__init__: init_api runs inside it, but the callback
        # it registers is only called once Live starts sending, by which
        # time these exist.
        self._previous = UNREAD
        self._last_logged = None

    def init_api(self):
        def set_identity(params: Tuple[Any] = ()):
            reply = (
                self._stored_id(),
                self._read("name", lambda: self.song.name),
                self._read("file_path", lambda: self.song.file_path),
            )
            if reply != self._last_logged:
                self.logger.info(
                    "MixingPal set identity: id=%r name=%r path=%r" % reply)
                self._last_logged = reply
            return reply

        self.osc_server.add_handler(
            "/live/mixingpal/get/set_identity", set_identity)

    def _read(self, what, read):
        try:
            value = read()
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: reading %s raised %r" % (what, e))
            return ""
        return value if isinstance(value, str) else ""

    def _stored_id(self):
        try:
            current = self.song.get_data(KEY, None)
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: get_data raised %r" % (e,))
            self._previous = UNREAD
            return ""
        report, write = decide(
            self._previous, current, lambda: uuid.uuid4().hex)
        self._previous = current
        if write is None:
            return report
        try:
            self.song.set_data(KEY, write)
            read_back = self.song.get_data(KEY, None)
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: writing the key raised %r" % (e,))
            return ""
        self.logger.info(
            "MixingPal set identity: wrote %r, read back %r"
            % (write, read_back))
        self._previous = read_back
        return valid_id(read_back)
```

- [ ] **Step 2: Register the handler**

In `remote-script/MixingPal/mixingpal/manager.py`, add the import after the `VersionHandler` import and the handler after `VersionHandler(self)`:

```python
from .version import VersionHandler
from .set_identity import SetIdentityHandler
```

```python
                VersionHandler(self),
                SetIdentityHandler(self),
            ]
```

In `remote-script/MixingPal/mixingpal/__init__.py`, add the import and the `__all__` entry:

```python
from .version import VersionHandler
from .set_identity import SetIdentityHandler

__all__ = [
    "MasterHandler", "ReturnHandler", "MixerHandler", "ClipNotesHandler",
    "DeviceRangeHandler", "ViewOverrideHandler", "VersionHandler",
    "RackHandler", "SetIdentityHandler",
]
```

- [ ] **Step 3: Bump the wire version in both places**

In `remote-script/MixingPal/mixingpal/version.py`, extend the history comment and change the literal. The last existing lines of the comment read `# pad's loaded sample-file name when Live exposes one. Version 11 marks Rack` / `# devices inside a Rack listing, so nested Drum Racks can be opened.` Replace the second of those and the `WIRE_VERSION = 11` line with:

```python
# devices inside a Rack listing, so nested Drum Racks can be opened. Version
# 12 adds /live/mixingpal/get/set_identity: the set's stored id, name, and
# path. A stale script knows no such address, so the app never learns which
# set is open and nothing per-set can be saved; the banner asks for the
# reinstall.
WIRE_VERSION = 12
```

`shared/wire-version.json` becomes:

```json
{ "version": 12 }
```

- [ ] **Step 4: State the exception on the read-only guard**

In `src-tauri/src/osc/socket.rs`, the doc comment on `is_read_only_address` ends with `/// doc comment.` at line 17. Add one paragraph before the `pub(crate) fn` line:

```rust
/// doc comment.
///
/// One thing this guard does not see: the connector itself writes the set's
/// identity key on a `/live/mixingpal/get/set_identity` poll, the single
/// exception carved out in docs/superpowers/specs/2026-09-07-set-identity-
/// design.md. The app still sends nothing but reads.
pub(crate) fn is_read_only_address(addr: &str) -> bool {
```

- [ ] **Step 5: Run the tests that pin the bump**

Run: `(cd src-tauri && cargo test wire_version 2>&1) | tee "$SCRATCH/cargo-task2.log" | grep -E "^test |test result"`
Expected: `wire_version_matches_the_shared_manifest ... ok`.

Run: `npx vitest run 2>&1 | tee "$SCRATCH/vitest-task2.log" | grep -E "Test Files|Tests "`
Expected: all green. If a vitest test pins the wire version literal, it reads the JSON, so it passes.

Run: `python3 -m unittest discover -s remote-script/tests -v 2>&1 | tee "$SCRATCH/py-task2.log" | tail -3`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add remote-script/MixingPal/mixingpal/set_identity.py remote-script/MixingPal/mixingpal/manager.py remote-script/MixingPal/mixingpal/__init__.py remote-script/MixingPal/mixingpal/version.py shared/wire-version.json src-tauri/src/osc/socket.rs
git commit -m "Answer /live/mixingpal/get/set_identity from the connector, at wire version 12

The one write this connector makes to a set, under the spec's conditions:
the identity key, only when absent on two consecutive polls, read back
before it is reported. Name and path ride in the same reply.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The spike, in Live

**Files:**
- Modify: `docs/manual-verification.md` (append a section)

**This task is run by the user, not by an implementer.** It needs Live open with the connector selected, which is GUI-only. The implementer's job is to append the checklist below to `docs/manual-verification.md`, commit it, and stop with status `BLOCKED` naming this task, so the controller hands it to the user. Tasks 4 to 6 do not depend on the spike's answers except as noted at the end of this task.

- [ ] **Step 1: Append the spike checklist to `docs/manual-verification.md`**

```markdown

## Set identity spike (wire 12)

Run on a **disposable copy** of a real set, never on one being worked on:
the first row writes to whatever set is open. The connector log is the
newest `abletonosc.log*` under `~/Music/Ableton/User Library/Remote Scripts/MixingPal/logs/`;
identity lines start with `MixingPal set identity`.

Install with `scripts/install-remote-script.sh`, then restart Live.

Date: ___________  Live version: ___________  Tester: ___________

- [ ] Modified flag. Open the copy, wait ten seconds, look at the title
      bar for the modified asterisk. Close the set: does Live ask to save?
      Pass: no asterisk, no prompt. Fail: either one. On a fail, the write
      is dropped: `decide` keeps only its first and third rows, and
      identity is the path.
- [ ] Survives a save. Save the copy once, close it, reopen it. The first
      `MixingPal set identity` line after reopening shows the same id.
      Pass: same id. Fail: a new id, or `id=''`; same outcome as a modified
      flag fail.
- [ ] First read is the stored value. In the same reopen, the first
      identity line already carries the id; no `wrote` line follows it.
      Pass: no second write. Fail: a `wrote` line after reopening; widen the
      two-read gate to three reads in `decide`.
- [ ] Unsaved set. File → New Live Set, wait, read the log. Pass:
      `path=''` and `name=''` (or the placeholder name Live gives an unsaved
      set; record what it says). Record the value either way.
- [ ] Close without saving. Open the copy fresh so it gets an id, close,
      choose Don't Save, reopen. Expected and accepted: a new id, since the
      write never reached disk. Record both ids.
- [ ] The handler runs after load. Open a set that has an id; the first
      identity line already shows it. Pass: yes.

Result: ___________ (write kept / write dropped)
```

- [ ] **Step 2: Commit the checklist and stop**

```bash
git add docs/manual-verification.md
git commit -m "Add the set identity spike checklist to manual verification

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then report `BLOCKED: Task 3 needs a person in front of Live`. The controller hands the checklist to the user and continues with Task 4; the user records the results in the same file in a later commit.

**If the spike drops the write** (modified-flag fail or save fail): before Task 7, change `decide` in `set_identity_rules.py` so its writing row is removed (`return "", None` for every no-valid-id case), delete `test_two_absent_reads_in_a_row_write_a_new_id`, and change the spec's write-decision table to its first and third rows. Nothing else in this plan changes: the frontend already falls back to the path.

---

### Task 4: The poll, gated on the handshake

**Files:**
- Modify: `src-tauri/src/osc/arity.rs` (the `KeyArity::None` arm around line 47 and the table test around line 198)
- Modify: `src-tauri/src/osc/pollers.rs`
- Modify: `src-tauri/src/lib.rs` (`EMITTED_ADDRESSES` near line 132, `POLL_LOOP_SENT_ADDRESSES` near line 181, `TrackCounts` at line 243, the receive-loop match near line 416, `poll_kind`'s match near line 1098, and the tests module)
- Modify: `shared/handled-addresses.json`

**Interfaces:**
- Consumes: the address from Task 2.
- Produces: the address mirrored into the frontend's delta stream as `Delta { addr: "/live/mixingpal/get/set_identity", args: [stored_set_id, name, file_path] }`. Task 5 consumes it.

At the end of this task, cargo is green and vitest's `shared/handled-addresses.json` test is red, because the manifest names an address `apply.ts` does not map yet. That is the tripwire working; Task 5 turns it green.

- [ ] **Step 1: Write the failing poll-gate test**

In `src-tauri/src/lib.rs`'s `mod tests`, after `poll_kind_faders_sends_nothing_while_num_tracks_is_unknown`, add:

```rust
    #[tokio::test]
    async fn poll_kind_set_identity_waits_for_a_connector_that_knows_the_address() {
        // A connector older than wire 12 logs an unknown address at ERROR
        // and forwards it to the app as /live/error, once per poll. At one
        // poll a second that would fill its log and our error stream until
        // she reinstalls, so nothing goes out until the handshake says 12+.
        let listener = OscSocket::bind_to(0, 0).await.unwrap();
        let poll_socket = OscSocket::bind_to(0, listener.local_port()).await.unwrap();
        let table = Mutex::new(RequestTable::new());
        let counts = Mutex::new(TrackCounts::default());
        let mut track_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut track_built_for: Option<(usize, usize)> = None;
        let mut mixer_queue: VecDeque<(usize, usize)> = VecDeque::new();
        let mut mixer_built_for: Option<usize> = None;

        for version in [None, Some(11)] {
            counts.lock().unwrap().script_version = version;
            poll_kind(
                PollKind::SetIdentity,
                Instant::now(),
                &table,
                &poll_socket,
                &counts,
                &mut track_queue,
                &mut track_built_for,
                &mut mixer_queue,
                &mut mixer_built_for,
            )
            .await;
            let nothing =
                tokio::time::timeout(Duration::from_millis(50), recv_message(&listener)).await;
            assert!(nothing.is_err(), "version {version:?} must not be asked for set_identity");
        }

        counts.lock().unwrap().script_version = Some(12);
        poll_kind(
            PollKind::SetIdentity,
            Instant::now(),
            &table,
            &poll_socket,
            &counts,
            &mut track_queue,
            &mut track_built_for,
            &mut mixer_queue,
            &mut mixer_built_for,
        )
        .await;
        let msg = tokio::time::timeout(Duration::from_millis(500), recv_message(&listener))
            .await
            .expect("a wire-12 connector is asked for set_identity")
            .unwrap();
        assert_eq!(msg.addr, "/live/mixingpal/get/set_identity");
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `(cd src-tauri && cargo test poll_kind_set_identity 2>&1) | tee "$SCRATCH/cargo-task4-red.log" | grep -E "^error|no variant|script_version" | head -5`
Expected: compile errors: no variant `SetIdentity`, no field `script_version`.

- [ ] **Step 3: Add the arity entry and its table row**

In `src-tauri/src/osc/arity.rs`, the `KeyArity::None` arm currently ends:

```rust
        | "/live/mixingpal/get/cue_points" => KeyArity::None,
```

Change it to:

```rust
        | "/live/mixingpal/get/cue_points"
        // The set's stored id, name, and path -- three strings, no key.
        // See mixingpal/set_identity.py and the 2026-09-07 spec.
        | "/live/mixingpal/get/set_identity" => KeyArity::None,
```

In the table test, after `("/live/mixingpal/get/cue_points", KeyArity::None),` add:

```rust
            ("/live/mixingpal/get/set_identity", KeyArity::None),
```

- [ ] **Step 4: Add the poll kind**

In `src-tauri/src/osc/pollers.rs`:

```rust
pub enum PollKind {
    TrackState,
    Faders,
    Selection,
    FocusedNotes,
    Meters,
    ScriptVersion,
    CuePoints,
    SetIdentity,
}
```

In `all()`, after `PollKind::CuePoints,`:

```rust
            PollKind::SetIdentity,
```

In `interval()`, after the `CuePoints` arm:

```rust
            // The set's identity changes only when a set loads, but that is
            // the moment the frontend most needs it, and the poll is one
            // small keyless message. Live re-creates the Control Surface
            // when a set loads; this poll is how the switch is seen.
            PollKind::SetIdentity => Duration::from_secs(1),
```

In `order()`:

```rust
            PollKind::CuePoints => 6,
            PollKind::SetIdentity => 7,
```

In `each_poll_kind_fires_at_its_own_rate`, the 1s assertion becomes:

```rust
        // Selection and set identity are 1s, notes 1.5s, track state and meters 2s.
        let at_1s = start + Duration::from_millis(1_050);
        assert_eq!(s.due(at_1s), vec![PollKind::Selection, PollKind::SetIdentity]);
```

In `due_orders_multiple_results_deterministically`, the expected vector becomes:

```rust
            vec![
                PollKind::TrackState,
                PollKind::Faders,
                PollKind::Selection,
                PollKind::FocusedNotes,
                PollKind::Meters,
                PollKind::SetIdentity,
            ]
```

- [ ] **Step 5: List the address in lib.rs and cache the version reply**

In `src-tauri/src/lib.rs`, `EMITTED_ADDRESSES` ends with the cue-points entry. After `"/live/mixingpal/get/cue_points",` add:

```rust
    // PollKind::SetIdentity, observed raw and mirrored like cue_points:
    // the frontend reads the set's id, name, and path from SetState.
    "/live/mixingpal/get/set_identity",
```

`POLL_LOOP_SENT_ADDRESSES` ends with `"/live/mixingpal/get/cue_points",`. After it add:

```rust
    "/live/mixingpal/get/set_identity",
```

`TrackCounts` gains one field:

```rust
#[derive(Default)]
struct TrackCounts {
    num_tracks: Option<usize>,
    num_scenes: Option<usize>,
    /// The last wire-version reply, so the poll loop, which cannot see the
    /// mirror, can hold back an address a stale connector does not know.
    script_version: Option<i64>,
    inflight_track_data: Option<(u32, u32)>,
    inflight_mixer_data: Option<(u32, u32)>,
    track_data_sent_at: Option<Instant>,
    mixer_data_sent_at: Option<Instant>,
}
```

In the receive loop's `match (msg.addr.as_str(), msg.args.first())`, after the `num_scenes` arm and before `_ => {}`:

```rust
        ("/live/mixingpal/get/version", Some(OscType::Int(v))) => {
            if let Ok(mut c) = counts.lock() {
                c.script_version = Some(i64::from(*v));
            }
        }
```

Near the top of `lib.rs`, beside the other `const` items (after `SUBSCRIPTION_RESEND_INTERVAL` is fine):

```rust
/// The first wire version whose connector answers
/// `/live/mixingpal/get/set_identity`. Polled only once the handshake has
/// said so; see `poll_kind`.
const SET_IDENTITY_WIRE_VERSION: i64 = 12;
```

In `poll_kind`'s match, after the `PollKind::CuePoints` arm:

```rust
        PollKind::SetIdentity => {
            // Gated on the handshake: a connector older than 12 does not
            // know this address, logs it at ERROR, and forwards the error
            // to the app once a poll. Nothing goes out until a version
            // reply says 12 or more.
            let version = counts.lock().map(|c| c.script_version).unwrap_or(None);
            if version.is_some_and(|v| v >= SET_IDENTITY_WIRE_VERSION) {
                register_and_send(
                    table,
                    poll_socket,
                    now,
                    "/live/mixingpal/get/set_identity",
                    vec![],
                )
                .await;
            }
        }
```

- [ ] **Step 6: Add the address to the shared manifest**

In `shared/handled-addresses.json`, after `"/live/mixingpal/get/cue_points"` in `songFields`:

```json
    "/live/mixingpal/get/cue_points",
    "/live/mixingpal/get/set_identity"
```

- [ ] **Step 7: Run cargo test**

Run: `(cd src-tauri && cargo test 2>&1) | tee "$SCRATCH/cargo-task4.log" | grep -E "^test result|FAILED|panicked"`
Expected: every `test result: ok`, including `poll_kind_set_identity_waits_for_a_connector_that_knows_the_address`, `each_poll_kind_fires_at_its_own_rate`, `every_emitted_address_is_handled_by_the_frontend_or_explicitly_allowed`, and `every_poll_loop_send_and_subscription_is_read_only`.

Run: `npx vitest run 2>&1 | tee "$SCRATCH/vitest-task4.log" | grep -E "Test Files|Tests |FAIL"`
Expected: exactly one failing file, `src/live/addresses.test.ts`, because the manifest is ahead of `apply.ts`. Task 5 fixes it. Any other failure is a defect in this task.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/osc/arity.rs src-tauri/src/osc/pollers.rs src-tauri/src/lib.rs shared/handled-addresses.json
git commit -m "Poll the set's identity once a second, only from a connector that knows the address

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: The identity in SetState

**Files:**
- Modify: `src/live/model.ts` (`SetState`)
- Modify: `src/live/apply.ts` (`emptySet`, a new exported constant and function, `applyDelta`)
- Modify: `src/live/apply.test.ts`
- Modify: `src/live/addresses.test.ts:11`
- Modify: `src/digest/toolPointer.test.ts`, `src/rules/unnamedTracks.test.ts`, `src/ui/progressLabel.test.ts`, `src/ui/summaryLine.test.ts` (each has a `SetState` literal that must gain the three fields)
- Modify: `shared/eval-set.json`, `shared/craft-set.json` (`song` blocks)

**Interfaces:**
- Consumes: the delta from Task 4.
- Produces: `SetState.setId`, `setName`, `setPath` (`string | null` each); `SET_IDENTITY_ADDR`; `setIdentityFrom(args: unknown[]): Pick<SetState, "setId" | "setName" | "setPath"> | null`. Task 6 reads the fields.

- [ ] **Step 1: Write the failing tests**

In `src/live/apply.test.ts`, extend the import to `import { applyDelta, emptySet, CUE_POINTS_ADDR, SET_IDENTITY_ADDR, setIdentityFrom } from "./apply";` (keep whatever it already imports) and add a describe block at the end:

```ts
describe("set identity", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("keeps the stored id, the name, and the path", () => {
    expect(setIdentityFrom([id, "Track", "/x/Track.als"])).toEqual({
      setId: id,
      setName: "Track",
      setPath: "/x/Track.als",
    });
  });

  // The frontend is the one owner of the fallback: the connector reports
  // only what it read from the set.
  it("falls back to the path when the set holds no id", () => {
    expect(setIdentityFrom(["", "Track", "/x/Track.als"])).toEqual({
      setId: "/x/Track.als",
      setName: "Track",
      setPath: "/x/Track.als",
    });
  });

  it("is all null for an unsaved set with no id", () => {
    expect(setIdentityFrom(["", "", ""])).toEqual({ setId: null, setName: null, setPath: null });
  });

  it("rejects a reply that is not three strings", () => {
    expect(setIdentityFrom([id, "Track"])).toBeNull();
    expect(setIdentityFrom([id, 7, "/x/Track.als"])).toBeNull();
  });

  it("applies a reply wholesale and a later one over it", () => {
    let s = applyDelta(emptySet(), { addr: SET_IDENTITY_ADDR, args: [id, "Track", "/x/Track.als"] });
    expect(s.setId).toBe(id);
    s = applyDelta(s, { addr: SET_IDENTITY_ADDR, args: ["", "", ""] });
    expect(s.setId).toBeNull();
    expect(s.setName).toBeNull();
    expect(s.setPath).toBeNull();
  });

  it("leaves the fields alone on a malformed reply", () => {
    const before = applyDelta(emptySet(), {
      addr: SET_IDENTITY_ADDR,
      args: [id, "Track", "/x/Track.als"],
    });
    const after = applyDelta(before, { addr: SET_IDENTITY_ADDR, args: [id] });
    expect(after).toBe(before);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/live/apply.test.ts 2>&1 | tee "$SCRATCH/vitest-task5-red.log" | grep -E "Tests |FAIL|Error" | head -5`
Expected: a failure to import `SET_IDENTITY_ADDR` / `setIdentityFrom`.

- [ ] **Step 3: Add the fields and the decoder**

In `src/live/model.ts`, `SetState` gains three fields after `cuePointsTotal`:

```ts
  cuePointsTotal: number | null;
  /// The set's identity, from /live/mixingpal/get/set_identity. setId is
  /// the id stored in the set, else its path, else null; the choice is
  /// made in apply.ts's setIdentityFrom. All null until the first reply.
  setId: string | null;
  setName: string | null;
  setPath: string | null;
}
```

In `src/live/apply.ts`, `emptySet()` gains:

```ts
    cuePointsTotal: null,
    setId: null,
    setName: null,
    setPath: null,
  };
```

After `CUE_POINTS_ADDR`'s definition add:

```ts
// Handled directly for the same reason CUE_POINTS_ADDR is: three strings
// that become three fields, with the id-else-path choice made here. The
// connector reports only what it read from the set; the frontend is the
// one owner of the fallback. See the 2026-09-07 set identity spec.
export const SET_IDENTITY_ADDR = "/live/mixingpal/get/set_identity";

/**
 * Decodes one identity reply. Empty strings mean "none" on the wire and
 * become null here. Anything that is not three strings is a reply this
 * version does not understand, and null tells applyDelta to keep what it
 * had rather than half-apply it.
 */
export function setIdentityFrom(
  args: unknown[],
): Pick<SetState, "setId" | "setName" | "setPath"> | null {
  if (args.length !== 3 || !args.every((a) => typeof a === "string")) return null;
  const [stored, name, path] = args as [string, string, string];
  const setPath = path === "" ? null : path;
  return {
    setId: stored === "" ? setPath : stored,
    setName: name === "" ? null : name,
    setPath,
  };
}
```

In `applyDelta`, after the `CUE_POINTS_ADDR` block and before `const songField = ...`:

```ts
  if (delta.addr === SET_IDENTITY_ADDR) {
    const identity = setIdentityFrom(delta.args);
    if (identity === null) return state;
    return { ...state, ...identity };
  }
```

- [ ] **Step 4: Name the address in the manifest test and fix every SetState literal**

In `src/live/addresses.test.ts`, the import becomes `import { SONG_FIELDS, TRACK_FIELDS, NUM_TRACKS_ADDR, CUE_POINTS_ADDR, SET_IDENTITY_ADDR } from "./apply";` and line 11 becomes:

```ts
const handledOutsideFieldMaps = [NUM_TRACKS_ADDR, CUE_POINTS_ADDR, SET_IDENTITY_ADDR];
```

Update its comment's first sentence to name three addresses: `// num_tracks, cue_points, and set_identity are handled directly in applyDelta`.

In each of `src/digest/toolPointer.test.ts`, `src/rules/unnamedTracks.test.ts`, `src/ui/progressLabel.test.ts`, and `src/ui/summaryLine.test.ts`, the `SetState` literal gains, after `cuePointsTotal: null,`:

```ts
  setId: null,
  setName: null,
  setPath: null,
```

In `shared/eval-set.json` and `shared/craft-set.json`, the `song` object gains, after its `"cuePointsTotal"` entry (add the three lines at the end of the object, before its closing brace, with a comma on the previous line):

```json
    "setId": null,
    "setName": null,
    "setPath": null
```

`src/digest/evalFixture.test.ts` types `song` as `Omit<SetState, "tracks">`, so the fixtures must carry the fields; the digest does not read them, so `shared/eval-context.txt` and `shared/craft-context.txt` do not change.

- [ ] **Step 5: Run vitest and the build**

Run: `npx vitest run 2>&1 | tee "$SCRATCH/vitest-task5.log" | grep -E "Test Files|Tests |FAIL"`
Expected: all files pass, including `src/live/addresses.test.ts`.

Run: `npm run build 2>&1 | tee "$SCRATCH/build-task5.log" | grep -E "error|built in" | head -5`
Expected: `built in`, no `error TS`.

- [ ] **Step 6: Commit**

```bash
git add src/live/model.ts src/live/apply.ts src/live/apply.test.ts src/live/addresses.test.ts src/digest/toolPointer.test.ts src/rules/unnamedTracks.test.ts src/ui/progressLabel.test.ts src/ui/summaryLine.test.ts shared/eval-set.json shared/craft-set.json
git commit -m "Carry the set's id, name, and path in SetState, with the id-else-path fallback in one place

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: The Set line in "What I can see"

**Files:**
- Modify: `src/ui/summaryLine.ts`
- Modify: `src/ui/summaryLine.test.ts`
- Modify: `src/ui/WhatICanSee.tsx:63-66`

**Interfaces:**
- Consumes: `SetState.setId`, `setName`, `setPath` from Task 5.
- Produces: `setLine(state: SetState): string | null`.

- [ ] **Step 1: Write the failing tests**

In `src/ui/summaryLine.test.ts`, extend the import to `import { summaryLine, setLine } from "./summaryLine";` and add:

```ts
describe("setLine", () => {
  const id = "0123456789abcdef0123456789abcdef";

  it("names the set", () => {
    expect(setLine({ ...BASE, setId: id, setName: "Track", setPath: "/x/Track.als" })).toBe(
      "Set  Track",
    );
  });

  // The one place she can see that a thread for this set will not follow a
  // rename: the id is the path, or there is none.
  it("says when the set has no stored id", () => {
    expect(
      setLine({ ...BASE, setId: "/x/Track.als", setName: "Track", setPath: "/x/Track.als" }),
    ).toBe("Set  Track · no stored id");
    expect(setLine({ ...BASE, setId: null, setName: "Track", setPath: null })).toBe(
      "Set  Track · no stored id",
    );
  });

  it("is absent until the first reply names the set", () => {
    expect(setLine(BASE)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/ui/summaryLine.test.ts 2>&1 | tee "$SCRATCH/vitest-task6-red.log" | grep -E "Tests |FAIL|Error" | head -3`
Expected: `setLine` is not exported.

- [ ] **Step 3: Write setLine and render it**

Append to `src/ui/summaryLine.ts`:

```ts
/**
 * The disclosure's Set line. Its job, like the rest of the panel, is proof
 * that the app reads the set, and the set's name is the plainest proof
 * there is. The suffix is the one place she can see that a thread for this
 * set will not follow a rename: the id fell back to the path, or there is
 * none yet. Null until a reply names the set, so an unnamed line never
 * renders as "Set" with nothing after it.
 */
export function setLine(state: SetState): string | null {
  if (state.setName === null) return null;
  const stored = state.setId !== null && state.setId !== state.setPath;
  return `Set  ${state.setName}${stored ? "" : " · no stored id"}`;
}
```

In `src/ui/WhatICanSee.tsx`, the import becomes `import { summaryLine, setLine } from "./summaryLine";` and the two `wics__line` divs become three:

```tsx
            <div className="wics__line">{summaryLine(state, indices.length)}</div>
            {setLine(state) !== null && <div className="wics__line">{setLine(state)}</div>}
            <div className="wics__line">
              connector v{state.scriptVersion ?? "—"} · this app expects v{wireVersion.version}
            </div>
```

- [ ] **Step 4: Run vitest and the build**

Run: `npx vitest run 2>&1 | tee "$SCRATCH/vitest-task6.log" | grep -E "Test Files|Tests |FAIL"`
Expected: all green.

Run: `npm run build 2>&1 | tee "$SCRATCH/build-task6.log" | grep -E "error|built in" | head -5`
Expected: `built in`, no `error TS`.

- [ ] **Step 5: Commit**

```bash
git add src/ui/summaryLine.ts src/ui/summaryLine.test.ts src/ui/WhatICanSee.tsx
git commit -m "Show the set's name in What I can see, and say when it has no stored id

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Close the roadmap item

**Files:**
- Modify: `docs/ROADMAP.md` (the "Where we are" line and item 3 under "Now")
- Modify: `docs/superpowers/specs/2026-09-07-set-identity-design.md:4` (status line)

Do this task only after the user has recorded the spike (Task 3) in `docs/manual-verification.md`. If the spike dropped the write, apply the change described at the end of Task 3 first, in its own commit.

- [ ] **Step 1: Update the roadmap**

In `docs/ROADMAP.md`, change `App 0.2.3, wire version 11.` to `App 0.2.3, wire version 12.` and replace item 3's body with:

```markdown
3. **Set identity.** Done <date>. The connector stores an id in the set
   with `Song.set_data` under one key, written only when absent, and
   answers `/live/mixingpal/get/set_identity` with the id, the set's name,
   and its path. `SetState` carries all three; `setId` falls back to the
   path. The spike's record is in `docs/manual-verification.md`. The one
   exception to the no-write rule; see "Not doing".
```

If the spike dropped the write, say so instead: the id is the path, and the write is not made.

- [ ] **Step 2: Mark the spec built**

Change the spec's status line to `Status: built <date>; see docs/superpowers/plans/2026-09-07-set-identity.md`.

- [ ] **Step 3: Commit**

```bash
git add docs/ROADMAP.md docs/superpowers/specs/2026-09-07-set-identity-design.md
git commit -m "Mark set identity done on the roadmap

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

## Whole-branch checks before the PR

- `npx vitest run && npm run build && (cd src-tauri && cargo test)` all green; `python3 -m unittest discover -s remote-script/tests -v` reports `OK`.
- `git diff main --stat` touches nothing under `src-tauri/src/tools/` and nothing in the system prompt.
- The Codex review panel has run on the branch (`codex exec ... < /dev/null`, per the project memory), and its findings are fixed or recorded.
- The connector installed in Live (`scripts/install-remote-script.sh`) reports wire 12 in the card's disclosure after a Live restart, and the Set line shows the open set's name.
