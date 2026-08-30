"""Path resolution and chain enumeration for Racks.

Deliberately free of Live imports. Everything under `abletonosc/` reaches
`ableton.v2.control_surface`, which exists only inside the application, so a
module that imports a handler cannot be tested anywhere else. `rack.py` holds
the OSC handlers; this file holds the logic that can be wrong, and
`remote-script/tests/test_rack_paths.py` exercises it with fakes.
"""

#--------------------------------------------------------------------------------
# Mirrors MAX_DATAGRAM - HEADER_SLACK in src-tauri/src/osc/budget.rs, and is
# pinned from the Rust side by rack_byte_ceiling_matches_the_budget. A handler
# that overfills a datagram makes sendto raise inside Live, and the client then
# receives NOTHING AT ALL -- silence, not truncation, indistinguishable from a
# lost reply. So this number is load-bearing and duplicated across a language
# boundary, which is exactly what the pin is for.
#--------------------------------------------------------------------------------
MAX_REPLY_BYTES = 8960

# Matches src-tauri/src/tools/path.rs::MAX_PATH_LEN. The client refuses a
# longer path before sending it; this is the second half of the same guard,
# because resolution runs on Live's callback thread.
MAX_PATH_LEN = 9

# Device names carried per chain. A chain with more reports the true count and
# a shorter list; a listing is for orientation, and the model drills in with
# get_device_params once it knows where to look.
MAX_DEVICES_PER_CHAIN = 32

# Caps every name on the wire. The Rust side fences to 120 characters anyway,
# so nothing real is lost, and it bounds the worst-case record: with the name
# list emptied, six fixed fields plus a capped name is far inside one datagram.
# That is what makes shrink_to_fit terminate with a record that always fits.
NAME_CAP = 200


def parse_path(raw):
    """"0.4.1" -> [0, 4, 1]. None for anything malformed.

    Refuses even lengths (a path names a device, and every step into a rack
    costs a chain index and a device index together), anything past
    MAX_PATH_LEN, and anything that is not an ASCII non-negative integer.
    int() would happily accept "-1" and Python slices from the END on a
    negative index, which resolves silently to a real but different device;
    it also accepts non-ASCII digits, which this app never generates.
    """
    parts = str(raw).split(".")
    if len(parts) > MAX_PATH_LEN or len(parts) % 2 == 0:
        return None
    out = []
    for part in parts:
        if not part or not part.isascii() or not part.isdigit():
            return None
        # A legal index is at most i32::MAX -- ten digits -- and the Rust
        # side refuses anything larger, so accepting it here would let the
        # two ends disagree about what a path is. The length check is not
        # redundant with the range check below it: the reply has to ECHO
        # this string, because it is part of the Args(3) key, so a
        # four-thousand-digit component would put four kilobytes into the
        # header and push the datagram past the cap -- and past the cap
        # means sendto raises and the client receives nothing at all.
        if len(part) > 10:
            return None
        value = int(part)
        if value > 2147483647:
            return None
        out.append(value)
    return out


def chains_of(device):
    """Every chain in a rack, as (chain, note, name, mute, solo).

    Listing and resolution BOTH go through this, and that is the point. A
    chain index has to mean the same chain when the model reads a listing and
    when it sends that index back inside a path.

    A Drum Rack is where this goes wrong. Its pad note lives on DrumPad, not
    on Chain, so the obvious implementation lists from `drum_pads` and
    resolves through `chains`, pairing the two by position. That pairing is an
    assumption about an ordering the LOM does not promise, and when it is
    wrong it is wrong silently: every pad labelled with its neighbour's note,
    inside an answer that looks complete. Enumerating pads on both sides
    removes the assumption instead of testing it.

    A device that is not a rack yields [] rather than raising, so "not a rack"
    reaches the client as an answer rather than as silence.
    """
    if getattr(device, "can_have_drum_pads", False):
        return [(pad.chains[0], pad.note, pad.name, pad.mute, pad.solo)
                for pad in device.drum_pads if len(pad.chains) > 0]
    return [(chain, -1, chain.name, chain.mute, chain.solo)
            for chain in getattr(device, "chains", [])]


def resolve(track, path):
    """track.devices[path[0]], then chain/device pairs to the end.

    Raises IndexError past the end of any list, which AbletonOSC turns into no
    reply at all -- byte-identical to a lost datagram, exactly as the
    top-level device addresses already behave.
    """
    device = track.devices[path[0]]
    for i in range(1, len(path), 2):
        chain = chains_of(device)[path[i]][0]
        device = chain.devices[path[i + 1]]
    return device


def osc_string_bytes(text):
    """An OSC string pads to a multiple of 4 with at least one NUL, plus one
    byte of type tag.

    Measured in UTF-8 BYTES, because that is what `pythonosc` writes
    (`osc_types.write_string` encodes with `val.encode('utf-8')`). Python's
    codepoint count under-counts an accented, CJK or emoji device name by up
    to 4x, and under-counting is what makes sendto raise -- which reaches
    the client as silence, not as truncation.
    """
    return 4 * ((len(str(text).encode("utf-8")) // 4) + 1) + 1


def record_bytes(record):
    """Serialised size of one chain record, type tags included."""
    return sum(osc_string_bytes(f) if isinstance(f, str) else 5 for f in record)


def chain_record(entry, max_names=MAX_DEVICES_PER_CHAIN):
    """(name, note, mute, solo, total_devices, reported_devices, *names).

    Six fixed fields, then exactly `reported_devices` names. The record
    announces how many names it actually carries -- not how many the chain
    has -- so the decoder can walk a stream of variable-length records with no
    separator, and so a record cut back to fit a datagram stays readable.
    `total_devices` still reports the truth.
    """
    chain, note, name, mute, solo = entry
    devices = list(chain.devices)
    names = [str(d.name)[:NAME_CAP] for d in devices[:max(0, max_names)]]
    return (str(name)[:NAME_CAP], int(note), int(bool(mute)), int(bool(solo)),
            len(devices), len(names)) + tuple(names)


def shrink_to_fit(entry, budget):
    """Halve a record's device-name list until it fits.

    Bottoms out at no names at all, which still reports the chain's own name
    and its true device count. The floor is roughly 230 bytes (a NAME_CAP name
    plus five integers), so a budget below that is violated silently; the only
    production caller passes MAX_REPLY_BYTES.
    """
    max_names = MAX_DEVICES_PER_CHAIN
    record = chain_record(entry, max_names)
    while max_names > 0 and record_bytes(record) > budget:
        max_names //= 2
        record = chain_record(entry, max_names)
    return record


def build_window(entries, start, span, budget=MAX_REPLY_BYTES):
    """Records from entries[start:], at most `span` and at most what fits.

    The HANDLER owns the window, not the client. Parameters are uniform enough
    for a client to budget -- 64 bytes each, 140 to a datagram. Chains are
    not: a four-device chain is about 340 bytes and a thirty-two-device chain
    about 2100. A client-side window sized for the first sends twenty-three of
    the second, serialises to roughly 48 KB, and Live's sendto raises so the
    client receives nothing at all. Only the sender knows the sizes.

    A single chain too large to fit alone is cut back rather than dropped, so
    every reply carries at least one record and the client's paging loop
    always makes progress.

    A negative start or span clamps to zero. This is safe because the handler
    echoes the clamped value, so the reply describes what it actually contains.
    """
    records = []
    used = 0
    for entry in entries[max(0, start):max(0, start) + max(0, span)]:
        record = chain_record(entry)
        size = record_bytes(record)
        if used + size > budget:
            if records:
                break
            record = shrink_to_fit(entry, budget)
            size = record_bytes(record)
        records.append(record)
        used += size
    return records
