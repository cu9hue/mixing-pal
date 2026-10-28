"""The identity key's rules, kept out of the handler so they can be tested
outside Live: `set_identity.py` holds the OSC plumbing, this file holds the
logic that can be wrong, the way `rack.py` and `rack_paths.py` split.

The 2026-09-07 set identity design (git history) is the spec. This is the
one write this connector ever makes to a set, and these functions are the
whole decision, including what the handler remembers between polls.
"""
import re
from collections import namedtuple

KEY = "mixingpal"

# The handler's "previous read" before its first poll. Distinct from None,
# which is what get_data returns for an absent key.
UNREAD = object()

_HEX32 = re.compile(r"^[0-9a-f]{32}$")

# The handler's whole memory between polls: the previous read (UNREAD before
# the first one) and whether a write has been attempted in this handler's
# lifetime. The transitions live here, not in the handler, so they can be
# tested outside Live.
State = namedtuple("State", ("previous", "write_attempted"))

# What a new handler starts with: no previous read, no write attempted.
INITIAL = State(previous=UNREAD, write_attempted=False)


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
    # fullmatch, not match: "$" also matches before a trailing newline, so
    # match() would call "<32 hex>\n" valid.
    if isinstance(set_id, str) and _HEX32.fullmatch(set_id):
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


def after_read(state, current, generate):
    """One poll's read of the key. Returns (state, report, write).

    `write` is the value to store with Song.set_data, or None. This wraps
    `decide` with the one-write latch: once a write has been attempted in
    this handler's lifetime, no second one is ever attempted, whether the
    first raised or read back without a valid id. A write that took needs
    no second attempt -- the next read finds the id -- and a write that
    failed would otherwise be retried once a second, forever, against the producer
    open set. The next attempt waits for the next set load, which is a new
    handler with a fresh state.
    """
    if state.write_attempted:
        return state._replace(previous=current), valid_id(current), None
    report, write = decide(state.previous, current, generate)
    return State(previous=current, write_attempted=write is not None), report, write


def after_write(state, read_back):
    """The read-back after a write. Returns (state, report).

    The read-back goes through the value rule only, never the write
    decision, so a write that did not take reports "".
    """
    return State(previous=read_back, write_attempted=True), valid_id(read_back)


def after_failed_read(state):
    """get_data raised: the state with no previous read.

    Two consecutive absent reads are what licenses a write, and a read that
    raised is not an absent read, so the count starts again.
    """
    return state._replace(previous=UNREAD)
