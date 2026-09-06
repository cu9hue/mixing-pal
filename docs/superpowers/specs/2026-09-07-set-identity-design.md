# Set identity — Design

Date: 2026-09-07
Status: draft, awaiting review
Roadmap item 3. Items 4 (per-set persistence) and 5 (per-set notes) build on it.

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

### What the Live API actually offers

`Song.get_data()` takes no key and returns one object; `Song.set_data(obj)`
replaces it. It is a single per-set slot, not a key-value store, and any other
Remote Script may already be using it. Two rules follow.

- **Merge, never replace.** If the slot holds `None`, write
  `{"mixingpal": {"set_id": <id>}}`. If it holds a dict, add the `mixingpal`
  key and leave every other key as it was. If it holds anything else, leave it
  alone: another script owns that slot, and the app falls back to B.
- **Write once.** Write only when no id is there. A set that has one is never
  written to again.

No `is_modified` exists in the API, so whether `set_data` marks the set dirty
cannot be checked from the script. It has to be seen.

### The spike

Before the app side is built, the connector side is installed and three things
are observed in Live. The handler logs what `get_data` returned and what it
wrote, so the connector log answers the last two.

| Question | How to see it | If yes |
| --- | --- | --- |
| Does writing the id mark a clean set as modified? | Open a saved set, wait ten seconds, look for the asterisk in the title bar; close the set and see whether Live asks to save. | The write is dropped. Identity is B: the path. `set_data` is never called. Item 4 then keys on the path and a versioned save starts a fresh thread. |
| What does `get_data` return on a set that has never held data? | The connector log on a fresh set. | Nothing to decide; the merge rule handles `None` and a dict. |
| What does `file_path` return on an unsaved set? | The connector log after File → New Live Set. | Expected: an empty string. The app maps it to `null`. |

The spike is the implementation's first commit, not a throwaway.

### Failure modes accepted

- **A copied set shares an id.** "Save As" to start a new track from an old
  one shares the old track's thread. Item 4 gives the thread a visible
  identity in the card so she can see it happened, and item 5's note can be
  cleared. Not solved here.
- **An unsaved set's id lives in memory.** If she closes without saving, the
  id is gone and anything item 4 stored under it is orphaned. Item 4's 30-day
  drop collects it.
- **Two scripts, one slot.** Another script that writes a non-dict to
  `set_data` wins the slot. The app falls back to the path for that set. The
  log says so.

## Wire

Wire version 12. One new address, in the connector's own namespace like the
version handshake and the locators:

```
/live/mixingpal/get/set_identity
  reply: (set_id: str, name: str, file_path: str)
```

Empty strings mean "none": an id that could not be written and no path to
fall back on, an unsaved set's empty path. The reply never carries the raw
`get_data` blob.

The handler lives in `remote-script/MixingPal/mixingpal/set_identity.py`.
The decision logic (read the slot, merge, choose the id to report) is a pure
function in the same file with no Live imports, taking the slot's value and
an id generator, so `remote-script/tests/test_set_identity.py` can load the
file by path the way `test_rack_paths.py` does. The handler class wraps it
with `self.song`. Ids are `uuid4().hex`.

`version.py` gets the one-line history note it gets for every bump, and
`shared/wire-version.json` moves to 12.

## App core

- `PollKind::SetIdentity`, interval 5 seconds, beside `ScriptVersion` in
  `osc/pollers.rs`. The same reasoning applies: the value never changes
  minute to minute, but Live re-creates the Control Surface when a set loads,
  and that is how a set switch is seen. `PollKind::all()` lists it.
- The address joins `EMITTED_ADDRESSES` in `lib.rs`, under the observed-raw
  comment block, and is **not** resolve-only: the frontend reads it from the
  mirror, exactly like the locators.
- Nothing in Rust reads the value. The tools and the prompt do not learn the
  set's name or id; the model has no use for either, and the name is not a
  fact about the music.

## Frontend

`SetState` gains three fields, all `null` until the first reply:

```ts
setId: string | null;    // the id from the set, else the path, else null
setName: string | null;  // Live's name for the set
setPath: string | null;  // the .als path, null when unsaved
```

`apply.ts` handles the address directly, like `CUE_POINTS_ADDR`: a three-arg
reply is not a single value to copy into one field. The choice "id, else
path" is made here, in one exported pure function, so a test can pin it:

| reply | setId |
| --- | --- |
| `("abc", "Track", "/x/Track.als")` | `"abc"` |
| `("", "Track", "/x/Track.als")` | `"/x/Track.als"` |
| `("", "", "")` | `null` |

`handled-addresses.json` lists the address under `songFields`, and
`addresses.test.ts`'s `handledOutsideFieldMaps` names it, so both consistency
tripwires stay green and keep meaning what they mean.

The digest does not include any of the three. The card does not show them
yet; the "What I can see" disclosure gets one line, `Set  Track`, since its
job is proof that the app reads the set and the set's name is the plainest
proof there is.

## What consumes it

- **Item 4** keys the saved thread on `setId`. A path-derived id is hashed
  before it becomes a filename.
- **Item 5** shows `setName` above the note.
- The pill and the card do nothing new on a set switch in this item. Item 4
  decides what a switch does to the thread on screen.

## Tests

- `test_set_identity.py`: an empty slot gets an id written and reported; a
  dict slot with a foreign key keeps that key and gains ours; a slot that
  already has our id is not written and the id is reported; a non-dict slot is
  left alone and an empty id is reported; the generator is called only when a
  write happens.
- `apply.test.ts`: the three-row table above, and that a later reply replaces
  an earlier one.
- The existing address tripwires on both sides, which fail until every list
  agrees.
- `pollers.rs`'s `each_poll_kind_fires_at_its_own_rate` gets the
  `SetIdentity` case.
- Manual: the spike table, recorded in `docs/manual-verification.md`.

## Not in this item

Persisting anything, showing the thread's identity in the card, handling a
set switch on screen, and any use of the id by the model. Those are items 4
and 5.
