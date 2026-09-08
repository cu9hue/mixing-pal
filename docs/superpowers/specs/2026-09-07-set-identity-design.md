# Set identity — Design

Date: 2026-09-07
Status: built 2026-09-08; see docs/superpowers/plans/2026-09-07-set-identity.md
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
Set under a key of ours; it lands in the `.als` on save. The connector reads
it on every poll and writes a fresh id when none is there. The id follows the
music: a "Save As" into `track v4.als` carries it, a rename carries it, a
move carries it.

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

- **One key.** `set_data("mixingpal", {"set_id": <32 hex>})`. Nothing else is
  ever written to the set, by this item or a later one, without a spec of its
  own that names it here.
- **Written only when absent.** Only when the key holds no valid id of ours,
  and only after two consecutive polls have read the same value without one.
  A set that has our id is never written to again.
- **Invisible.** It must not mark a clean set as modified, and it must not
  change anything she can see in Live. If the spike shows it does either, the
  write is dropped and identity is B. There is no version of this that asks her
  to save a set she did not touch.
- **Read back before use.** After a write the connector calls `get_data`
  again and reports only what the key now holds, validated by the same rule
  as any other read and never re-minted. A write Live rejected, normalised,
  or dropped reports `""`, never the id the connector meant to store.

Two places in the code state the old rule and must state the exception in
the same change: the roadmap's "Not doing" section, and the doc comment on
`is_read_only_address` in `src-tauri/src/osc/socket.rs`, which says the app is
read-only because nothing reaches a `/set/` address. That guard stays exactly
as it is; the comment gains one sentence saying that the connector, not the
app, writes the identity key on a `/get/` poll, and points here.

### What the Live API actually offers

Verified against the Live 12 and Live 11 references (`Live.Song.runtime`):

```
get_data( (Song)arg1, (object)key, (object)default_value) -> object
    Get data for the given key, that was previously stored using set_data.
set_data( (Song)arg1, (object)key, (object)value) -> None
    Store data for the given key in this object. The data is persistent and
    will be restored when loading the Live Set.
```

A keyed store, so another Remote Script cannot see or overwrite our value
unless it chooses the string `"mixingpal"`. `file_path` and `name` are
read-only properties of `Song` in both versions; the Live Object Model
reference adds that both are empty for a set that has not been saved. Which
Python types `set_data` round-trips through the `.als` is documented nowhere
found; the spike settles it for a dict of one string.

**The value rule**, applied to what `get_data("mixingpal", None)` returns:

| Value holds | Valid id |
| --- | --- |
| a dict whose `"set_id"` is 32 lowercase hex characters | that string |
| anything else, including `None` | none |

Extra keys beside `"set_id"` are ignored and, since a set with a valid id is
never written to, never removed. That is how a later version adds a field
without dropping every existing set into the fallback: it adds a key, and it
keeps `"set_id"`. A value with no valid id is never repaired: it is ours from
a future shape this version cannot read, or a stranger's under our key, and
in both cases the app falls back to the path and the connector log says why.

**The write decision**, one pure function over two consecutive reads:

| Previous read | This read | Action |
| --- | --- | --- |
| any | valid id `s` | report `s`; no write |
| `None` | `None` | write `{"set_id": new}`, read back, report what the value rule says of the read-back |
| anything else | no valid id | report `""`; no write |

`None` is `get_data`'s default: the key is absent. Only an absent key is
ever written; a value under our key with no valid id is never repaired,
which is what the value rule promises. Two consecutive absent reads are what
stands between a transient default during a document load and a write; the
first poll after the handler is created has no previous read and never
writes. The read-back goes through the value rule only, never the write
decision, so a write that did not take reports `""` and the next poll starts
the two-read count again. `set_data` raising is caught, logged, and reported
as `""`. A write that raises or reads back without a valid id is not retried
in this handler's lifetime; the next set load (a new handler) may try once
again.

### The spike

Before the app side is built, the connector side is installed and Live
answers the questions below, on a **disposable copy** of a real set, never on
one she is working on: the dirtying probe writes to whatever set is open, and
fallback can only be chosen after the write has happened once. The handler
logs each read that differs from the previous one, every write, and every
read-back, with `file_path` and `name` beside them.

| Question | How to see it | Gate |
| --- | --- | --- |
| Does the write mark a clean set as modified? | Open the copy, wait ten seconds, look for the asterisk in the title bar; close the set and see whether Live asks to save. | If yes, the write is dropped, identity is B, and `set_data` is never called. The write decision keeps its first and third rows only. |
| Does the id survive save, close, and reopen? | Save the copy once, close it, reopen it, read the log: the first read on the new instance is the same id. | If no, same outcome as the row above: a write that does not persist is a write for nothing. |
| Is the first read after reopening the stored value, not the default? | The same reopen; the log's first identity read already shows our id, not `None`. | If no, the two-read gate is what stands between a transient and a write, and its window is widened to three polls. |
| What does `file_path` return on an unsaved set? | The log after File → New Live Set. | Expected: an empty string. The app maps it to `null`. |
| What happens when she closes a saved set without saving after the write? | Open the copy fresh so it gets an id, close, choose Don't Save, reopen, read the log. | Expected: a new id, since the write never reached disk. Item 4's lookup by id then path is the answer; see Failure modes. |

Also read off the log: the first identity poll after a set opens must land
after Live has finished loading it. Live creates the Control Surface for a
document after the document exists, so the handler never runs mid-load. The
spike confirms it by opening a set that has an id and checking that the first
logged read already shows it.

The spike is the implementation's first commit, not a throwaway. Its results
go in `docs/manual-verification.md`.

### Failure modes accepted

- **A copied set shares an id.** "Save As" to start a new track from an old
  one shares the old track's thread. Item 4 gives the thread a visible
  identity in the card so she can see it happened, and item 5's note can be
  cleared. Not solved here.
- **An id that never reached disk.** A set she opens and closes without
  saving, saved before or not, loses the id the connector gave it, and the
  next open mints another. This is why `setPath` travels with `setId`: item
  4 looks a thread up by id first and by path second, and when the path
  matches a thread whose id does not, it adopts that thread under the new id.
  A set she never saves and never reopens leaves an orphan; item 4's 30-day
  drop collects it.
- **No kill switch.** The dirtying gate is one spike, on one machine and one
  Live version, and there is one producer. If a later Live build dirties the
  set, the remedy is a connector without the write, shipped the way every
  connector ships today. A remote flag arrives with the proxy (launch track,
  item 1), which is the first place one could live.
- **Rollback leaves the key.** A connector that stops writing does not
  remove the key from sets that already have it. There is no delete path,
  by design: the key is inert, and removing it would be a second write.

## Wire

Wire version 12. One new address, in the connector's own namespace like the
version handshake and the locators:

```
/live/mixingpal/get/set_identity
  reply: (stored_set_id: str, name: str, file_path: str)
```

`stored_set_id` is exactly what the value rule reports: the id read from the
set, or `""` when there is none to report. The connector makes no choice
between id and path; that is the frontend's, below. Empty strings mean "none"
throughout: an unsaved set's `file_path`, a set with no id. Each of the three
reads is guarded on its own: `get_data`, `name`, or `file_path` raising is
caught, logged, and reported as `""` for that field, so one bad property never
takes the other two down with it, and the id and the path can never both be
lost to one exception. The vendored encoder writes an empty OSC string as a
valid zero-length string, so the sentinel is safe on the wire.

**Two Python files**, because the test convention loads modules by path and
the handler base class imports `ableton.v2`, which exists only inside Live.
The split follows `rack_paths.py`'s own rule: the handler file holds the OSC
plumbing, the other file holds the logic that can be wrong.

- `remote-script/MixingPal/mixingpal/set_identity_rules.py`, no Live
  imports: `valid_id(value) -> str` (the value rule, `""` for none) and
  `decide(previous, current, generate) -> (report, write)` (the write
  decision; `write` is the value to store or `None`), plus what the handler
  remembers between polls -- the previous read and the one-write latch -- as
  `after_read`, `after_write`, and `after_failed_read` over an immutable
  `State`. Both tables above are its tests, in
  `remote-script/tests/test_set_identity_rules.py`, loaded by path the way
  `test_rack_paths.py` does.
- `remote-script/MixingPal/mixingpal/set_identity.py`: `SetIdentityHandler`,
  an `AbletonOSCHandler` that holds the state, calls `after_read`, calls
  `set_data` and then `get_data` when told to write, hands the read-back to
  `after_write`, and answers the address with the three strings. Its own
  logic is the three try/excepts and the logging, nothing else. Registered in `MixingPalManager.init_api` in `manager.py`, after
  `VersionHandler`; a handler that is not in that list serves nothing.

Logging is on change and on write only: a read that equals the previous one
is silent. The connector log rotates at 2 MB, and a line per second would
turn the spike's own evidence over in a day.

`version.py` gets the one-line history note it gets for every bump, and
`shared/wire-version.json` moves to 12.

## App core

Every polled address touches four lists in Rust, and a missing entry in the
first is a panic on the first poll, not a silent gap.

- `osc/arity.rs`: `"/live/mixingpal/get/set_identity" => KeyArity::None`,
  and the matching row in its table test. `Requests::register` panics on
  `KeyArity::Unknown` (`osc/requests.rs:83`), and the startup poll fires
  immediately.
- `osc/pollers.rs`: `PollKind::SetIdentity`, interval 1 second, the same as
  `Selection`, in `PollKind::all()`, and a case in
  `each_poll_kind_fires_at_its_own_rate`. Not 5 seconds like the version:
  the value changes only when a set loads, but that is the moment the
  frontend most needs it, and the poll is one small keyless message. Live
  re-creates the Control Surface when a set loads, and this poll is how the
  switch is seen.
- **Gated on the handshake.** The arm sends nothing until the last version
  reply is 12 or more. The cached reply is replaced only by the next
  version reply, so a connector downgraded below 12 while the app is open
  is asked for the address for up to five polls, one per second, until the
  five-second version poll corrects it. Accepted: bounded, self-correcting,
  and a downgrade with the app open is a reinstall gone wrong, not a path. A stale connector logs every unknown address at
  ERROR and forwards it to the app as `/live/error`; at one a second that
  would fill the connector's log and the app's error stream until she
  reinstalls. The poll loop cannot see the mirror, so it keeps the last
  version reply in a shared cell the receive loop fills, the way it already
  keeps the track count for `TrackState`.
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
gets one line: `Set  Track`, and `Set  Track · no stored id` when `setId` is
null or path-derived. Its job is proof that the app reads the set, the name is
the plainest proof there is, and the suffix is the one place she can see that
a thread for this set will not follow a rename. Nothing else in the card
changes.

### The switch window

When she opens a different set, the mirror keeps the old set's three fields
until the new set's first identity reply lands: about a second at the 1s
poll, longer if a reply is lost, since UDP promises nothing. Nothing in this
item acts on identity, so nothing in this item is wrong during that window.
The rules for what does act on it, binding on items 4 and 5:

- **Act on change, not on presence.** A consumer restores or switches when
  `setId` changes from one value to another, never because a value is there.
  During the window nothing changes, so nothing happens; when the reply lands,
  the switch is processed once.
- **A promotion is not a switch.** Every set the connector has not written
  yet goes through two states in a row: the first reply carries no id, so
  `setId` is the path; one or two polls later the write lands and `setId`
  becomes the stored id. That is the normal path for every new set, not an
  edge case. A change from a path-derived `setId` to a stored one with the
  same `setPath` is the same set, and a consumer carries whatever it filed
  under the path across to the id.
- **Tag at send time.** Anything filed per set is tagged with the `setId`
  current when it was created, and is saved under that tag, not under
  whatever `setId` is current when the save runs.
- **The Set line leads the panel.** The identity poll lands about a second
  after a switch; tempo, key, and the track table come from subscriptions
  Live drops on load, which the app resends every ten seconds. For up to
  ten seconds the disclosure names the new set above the old set's facts.
  Accepted: the line is the freshest thing in the panel, and the panel's
  other lines catch up on their own clock. Nothing acts on it.
- **Debounce a flap.** A late reply from the old set arriving after the new
  set's first reply would flip identity back for one poll. Replies are
  mirrored in arrival order, and on localhost a one-second cadence does not
  reorder in practice, but a consumer treats an A→B→A→B flap as one switch:
  act on a change only once it has held for two consecutive polls.

The residual, accepted here and owned by item 4: a question she sends inside
the window, within about a second of the connector coming up on the new set
and before the card shows that set's tracks, is filed under the old set. One
exchange, visible in the card.

## What consumes it

- **Item 4** keys the saved thread on `setId`, under the rules above. A
  path-derived id is hashed before it becomes a filename.
- **Item 5** shows `setName` above the note.
- The pill and the card do nothing new on a set switch in this item.

## Tests

- `test_set_identity_rules.py`: one case per row of the value rule (valid;
  `None`; a non-dict; a dict without `set_id`; a `set_id` that is not 32
  lowercase hex; a valid `set_id` beside extra keys, which stays valid) and
  one per row of the write decision, plus: the generator is called only on
  the writing row; the first poll, with no previous read, never writes; a
  dict without our id is never written over.
- `apply.test.ts`: the three-row table above, a later reply replacing an
  earlier one, and a malformed reply leaving the fields alone.
- `arity.rs`'s table test and `pollers.rs`'s rate test, each with the new
  row; a test that the identity arm sends nothing while the last version
  reply is below 12.
- The existing address tripwires on both sides, which fail until every list
  agrees.
- Manual: the spike table, recorded in `docs/manual-verification.md`.

## Not in this item

Persisting anything, showing the thread's identity in the card beyond the
disclosure line, handling a set switch on screen beyond the rules above, and
any use of the id by the model. Those are items 4 and 5.
