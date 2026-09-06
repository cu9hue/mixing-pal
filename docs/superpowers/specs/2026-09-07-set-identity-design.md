# Set identity — Design

Date: 2026-09-07
Status: draft, revised after a Codex review of the first draft; awaiting review
Roadmap item 3. Items 4 (per-set persistence) and 5 (per-set notes) build on it.
Carves one exception out of the first spec's "No write access" non-goal; see
The exception below.

## Goal

The app cannot tell which set is open. The mirror carries tempo, key, tracks,
and locators, and none of that names the set. Everything per-set needs a name
for it that survives the app closing and the set reopening: the thread in item
4, the note in item 5.

One value, `setId`, in `SetState`, stable across app restarts and Live
restarts for the same piece of music. Plus the set's own name, because the
card will want to show it.

## What identity is

Two candidates. The roadmap named the first; the API turned up the second.

**A. An id stored in the set.** `Song.set_data` writes a value into the Live
Set; it lands in the `.als` on save. The connector reads it on every poll and
writes a fresh id when none is there. The id follows the music: a "Save As"
into `track v4.als` carries it, a rename carries it, a move carries it.

**B. The set's path on disk.** `Song.file_path` is read-only and exists in the
API ("Get the current Live Set's path on disk"). No write, no question about
dirtying the set, and an unsaved set has no path, which is honest: it has no
file either. But identity dies on every rename, move, and versioned save, and
producers save versions constantly.

**Decision: A, with B as the fallback and the name alongside.** The thread must
follow a versioned save or item 4 is worth little. The costs of A are real and
each has an answer below. The connector answers one address with all three
values so the app can choose without a second round trip.

## The exception

The first spec's non-goal reads "No write access. The copilot advises; the
producer acts." The roadmap carries it as "no writes to the set". Storing an
id is a write to the set, and this spec is where that is decided rather than
discovered.

The rule is reworded, in the roadmap, to **no writes to the set's contents**:
nothing the app does changes a note, a clip, a device, a fader, a name, a
locator, or anything else she can see or hear in Live. The one thing the app
may write is its own identity key, under these conditions and no others:

- **One key.** `data["mixingpal"]`, holding exactly `{"set_id": <32 hex>}`.
  Nothing else is ever written to the set, by this item or a later one, without
  a spec of its own that names it here.
- **Written once.** Only when the slot has no valid key of ours. A set that has
  one is never written to again, by any poll, ever.
- **Invisible.** It must not mark a clean set as modified, and it must not
  change anything she can see in Live. If the spike shows it does either, the
  write is dropped and identity is B. There is no version of this that asks her
  to save a set she did not touch.
- **Read back before use.** The app trusts only what the connector reads from
  the slot, never what it intended to write.

The reword lands in `docs/ROADMAP.md` in the same commit as this spec, so the
rule and its exception are one change.

### What the Live API actually offers

`Song.get_data()` takes no key and returns one object; `Song.set_data(obj)`
replaces it. It is a single per-set slot, not a key-value store, and any other
Remote Script may already be using it. So the connector treats the slot as
someone else's until proven otherwise.

**The owned schema.** Ours is one key in a dict:

```
data == None
data == {}                                     # nothing there yet
data == {..., "mixingpal": {"set_id": "<32 lowercase hex>"}, ...}
```

**The slot rule**, applied on every poll, in order:

| Slot holds | Connector does | Reports |
| --- | --- | --- |
| `None` | writes `{"mixingpal": {"set_id": new}}` | `new` |
| a dict with no `"mixingpal"` key | writes the same dict plus our key; every other key kept as it was | `new` |
| a dict whose `"mixingpal"` is `{"set_id": s}` with `s` 32 lowercase hex | nothing | `s` |
| a dict whose `"mixingpal"` is anything else | nothing | `""` |
| anything that is not `None` or a dict | nothing | `""` |

"Nothing" means `set_data` is not called. There is no repair path: a malformed
`"mixingpal"` value is someone else's data, or ours from a future version, and
either way the app falls back to the path for that set and the connector log
says why. The pure function that implements this table takes the slot's value
and an id generator, and the generator is called only on the two writing rows.

**No compare-and-swap.** Another script can read the slot, drop our key, and
write it back, and the next poll cannot tell that from a set that never had
one. It mints a new id and the thread splits at that moment. The alternative,
never minting when the slot already holds someone else's dict, would leave
every set that shares Live with such a script without an id at all. The split
is accepted and recorded here; item 4's card identity makes it visible when it
happens.

### The spike

Before the app side is built, the connector side is installed and Live
answers four questions. The handler logs what `get_data` returned, what it
wrote, and what `file_path` and `name` returned, so the connector log answers
the last three. The first is read off Live's window.

| Question | How to see it | Gate |
| --- | --- | --- |
| Does the write mark a clean set as modified? | Open a saved set, wait ten seconds, look for the asterisk in the title bar; close the set and see whether Live asks to save. | If yes, the write is dropped, identity is B, and `set_data` is never called. The pure function keeps the table above minus its two writing rows. |
| Does the id survive save, close, and reopen? | Save the set once, close it, reopen it, read the log: same id, and `get_data` returned our dict, not `None`. | If no, same outcome as the row above: a write that does not persist is a write for nothing. |
| What does `get_data` return on a set that has never held data? | The connector log on a fresh set. | Nothing to decide; the table handles `None` and `{}`. |
| What does `file_path` return on an unsaved set? | The connector log after File → New Live Set. | Expected: an empty string. The app maps it to `null`. |

Also read off the log: the first identity poll after a set opens must land
after Live has finished loading it. Live creates the Control Surface for a
document after the document exists, so the handler never runs mid-load. The
spike confirms it by opening a set and checking that the first logged read
already shows that set's `name`.

The spike is the implementation's first commit, not a throwaway. Its results go
in `docs/manual-verification.md`.

### Failure modes accepted

- **A copied set shares an id.** "Save As" to start a new track from an old
  one shares the old track's thread. Item 4 gives the thread a visible
  identity in the card so she can see it happened, and item 5's note can be
  cleared. Not solved here.
- **An unsaved set's id lives in memory.** If she closes without saving, the
  id is gone and anything item 4 stored under it is orphaned. Item 4's 30-day
  drop collects it.
- **Two scripts, one slot.** Covered by the slot rule and the no-CAS note
  above.

## Wire

Wire version 12. One new address, in the connector's own namespace like the
version handshake and the locators:

```
/live/mixingpal/get/set_identity
  reply: (stored_set_id: str, name: str, file_path: str)
```

`stored_set_id` is exactly what the slot rule reports: the id read back from
the set, or `""` when there is none to report. The connector makes no choice
between id and path; that is the frontend's, below. Empty strings mean "none"
throughout: an unsaved set's `file_path`, a set with no id. The reply never
carries the raw `get_data` blob. The vendored encoder writes an empty OSC
string as a valid zero-length string, so the sentinel is safe on the wire.

**Two Python files**, because the test convention loads modules by path and
the handler base class imports `ableton.v2`, which exists only inside Live:

- `remote-script/MixingPal/mixingpal/set_identity_slot.py`: the slot rule as
  a pure function, `resolve(slot, generate) -> (stored_set_id, new_slot)`,
  where `new_slot` is `None` when nothing is to be written. No Live imports.
  `remote-script/tests/test_set_identity_slot.py` loads it by path the way
  `test_rack_paths.py` does.
- `remote-script/MixingPal/mixingpal/set_identity.py`: `SetIdentityHandler`,
  an `AbletonOSCHandler` that calls `resolve` with `self.song.get_data()` and
  `uuid.uuid4().hex`, calls `self.song.set_data(new_slot)` when asked to,
  logs what it read and wrote, and answers the address with the three
  strings. Registered in `MixingPalManager.init_api` in `manager.py`, after
  `VersionHandler`; a handler that is not in that list serves nothing.

`version.py` gets the one-line history note it gets for every bump, and
`shared/wire-version.json` moves to 12.

## App core

Every polled address touches four lists in Rust, and a missing entry in the
first is a panic on the first poll, not a silent gap.

- `osc/arity.rs`: `"/live/mixingpal/get/set_identity" => KeyArity::None`,
  and the matching row in its table test. `Requests::register` panics on
  `KeyArity::Unknown` (`osc/requests.rs:83`), and the startup poll fires
  immediately.
- `osc/pollers.rs`: `PollKind::SetIdentity`, interval 5 seconds, beside
  `ScriptVersion`, in `PollKind::all()`, and a case in
  `each_poll_kind_fires_at_its_own_rate`. The same reasoning as the version:
  the value never changes minute to minute, but Live re-creates the Control
  Surface when a set loads, and that is how a set switch is seen.
- `lib.rs`: the address joins `EMITTED_ADDRESSES` under the observed-raw
  comment block, and `POLL_LOOP_SENT_ADDRESSES`. It is **not** resolve-only:
  the frontend reads it from the mirror, exactly like the locators.
- The poll arm sends it the way `PollKind::CuePoints` does, keyless.

Nothing in Rust reads the value. The tools and the prompt do not learn the
set's name or id; the model has no use for either, and the name is not a fact
about the music.

## Frontend

`SetState` gains three fields, all `null` until the first reply:

```ts
setId: string | null;    // stored id, else path, else null
setName: string | null;  // Live's name for the set
setPath: string | null;  // the .als path, null when unsaved
```

`apply.ts` handles the address directly, like `CUE_POINTS_ADDR`: a three-arg
reply is not a single value to copy into one field. The frontend is the one
owner of the fallback, in an exported pure function `setIdentityFrom(args)`:

| reply | setId | setName | setPath |
| --- | --- | --- | --- |
| `("abc…", "Track", "/x/Track.als")` | `"abc…"` | `"Track"` | `"/x/Track.als"` |
| `("", "Track", "/x/Track.als")` | `"/x/Track.als"` | `"Track"` | `"/x/Track.als"` |
| `("", "", "")` | `null` | `null` | `null` |

A later reply replaces an earlier one wholesale. A reply that is not three
strings is ignored and the three fields keep their values.

`handled-addresses.json` lists the address under `songFields`, and
`addresses.test.ts`'s `handledOutsideFieldMaps` names it, so both consistency
tripwires stay green and keep meaning what they mean.

The digest does not include any of the three. The "What I can see" disclosure
gets one line, `Set  Track`, since its job is proof that the app reads the set
and the set's name is the plainest proof there is. Nothing else in the card
changes.

### The switch window

When she opens a different set, the mirror keeps the old set's three fields
until the new set's first identity reply lands, up to five seconds. Nothing
in this item acts on identity, so nothing in this item is wrong during that
window. The rule for what does act on it, binding on items 4 and 5:

- **Act on change, not on presence.** A consumer restores or switches when
  `setId` changes from one value to another, never because a value is there.
  During the window nothing changes, so nothing happens; when the reply lands,
  the switch is processed once.
- **Tag at send time.** Anything filed per set is tagged with the `setId`
  current when it was created, and is saved under that tag, not under
  whatever `setId` is current when the save runs.

The residual: a question she sends inside the window, seconds after opening a
new set, is filed under the old set. That is one exchange, visible in the
card, and item 4 says what she can do about it.

## What consumes it

- **Item 4** keys the saved thread on `setId`, under the switch rule above. A
  path-derived id is hashed before it becomes a filename.
- **Item 5** shows `setName` above the note.
- The pill and the card do nothing new on a set switch in this item.

## Tests

- `test_set_identity_slot.py`, one case per row of the slot table, plus: a
  dict with a foreign key keeps that key byte for byte after the write; the
  generator is called only on the two writing rows; a `"set_id"` that is not
  32 lowercase hex is the "anything else" row.
- `apply.test.ts`: the three-row table above, a later reply replacing an
  earlier one, and a malformed reply leaving the fields alone.
- `arity.rs`'s table test and `pollers.rs`'s rate test, each with the new
  row.
- The existing address tripwires on both sides, which fail until every list
  agrees.
- Manual: the spike table, recorded in `docs/manual-verification.md`.

## Not in this item

Persisting anything, showing the thread's identity in the card, handling a
set switch on screen beyond the rule above, and any use of the id by the
model. Those are items 4 and 5.
