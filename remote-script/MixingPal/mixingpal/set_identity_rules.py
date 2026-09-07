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
