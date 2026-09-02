"""Reply shapes for the arrangement endpoints, in a module Live cannot reach.

Same reason `clip_replies.py` and `rack_paths.py` exist: the client decodes
these tuples positionally, so the ORDER of a clip's three fields and the
position of the echoed header are a contract between this file and
`src-tauri/src/tools/arrangement.rs`. Getting either wrong produces a
timeline that is plausible and wrong.

Nothing here imports Live, so `remote-script/tests` can exercise it directly.
"""

import hashlib

# Caps every name on the wire. The Rust side fences to 120 characters anyway,
# so a longer one cannot survive the trip intact.
NAME_CAP = 120

#--------------------------------------------------------------------------------
# Mirrors MAX_DATAGRAM - HEADER_SLACK in src-tauri/src/osc/budget.rs, and is
# pinned from the Rust side by arrangement_byte_ceiling_matches_the_budget, the
# way rack_paths.py's identical constant is pinned by
# rack_byte_ceiling_matches_the_budget. One datagram's worth, under the
# 9216-byte macOS UDP cap with room for the address and type tags. Past it,
# Live's sendto raises and the client receives NOTHING AT ALL -- silence, not
# truncation, indistinguishable from a lost reply.
#--------------------------------------------------------------------------------
MAX_REPLY_BYTES = 8960


def clip_record(clip):
    """One arrangement clip, as (name, start_time, length, looping, loop_start, loop_end).

    `track.arrangement_clips` yields Clip OBJECTS, not ids -- probed against
    Live 12 on 2026-08-30 via upstream's own
    `/live/track/get/arrangement_clips/name`, which answered `,isssssssss`
    for a nine-clip track. Cycling '74's LOM docs describe this property as
    a list of ids, but that is the Max-for-Live access layer; the Python
    control-surface API hands back objects, the same way `clip_slots[i].clip`
    already does everywhere else in this package. Attribute access here is
    therefore safe.

    That probe also found every one of those nine names empty: Live shows a
    derived label in the timeline and leaves `clip.name` unset. Unnamed is
    the normal case on the arrangement, and `arrangement.rs` omits the field
    rather than sending a bare fence.

    One pass over the clip, so its timing values are read together and cannot
    disagree. Reading them from three separate endpoints is what this
    endpoint exists to avoid: three replies are three moments, and a producer
    editing between them mis-zips the timeline silently.
    """
    looping = bool(clip.looping)
    if looping:
        loop_start = float(clip.loop_start)
        loop_end = float(clip.loop_end)
    else:
        # Keep one fixed record shape. These values have no meaning while
        # looping is false, and the Rust decoder omits them from JSON.
        loop_start, loop_end = 0.0, 0.0
    return (str(clip.name)[:NAME_CAP], float(clip.start_time), float(clip.length),
            looping, loop_start, loop_end)


def _record_bytes(record):
    """Roughly what one record costs on the wire.

    The name is the only variable part; the numbers are 4 bytes each plus a
    type tag, and OSC pads strings to a 4-byte boundary with at least one
    NUL. An over-estimate: 16 covers three type tags and two 4-byte floats
    with a whole slot to spare, and a record with one number costs even less
    than that.

    The name is measured in UTF-8 BYTES, because that is what `pythonosc`
    writes (`osc_types.write_string` encodes with `val.encode('utf-8')`).
    Measuring Python's codepoint count instead under-counts an accented, CJK
    or emoji clip name by up to 4x, and under-counting is what makes sendto
    raise.
    """
    name = str(record[0]).encode("utf-8")
    # Four floats occupy sixteen bytes. The boolean carries only an OSC type
    # tag, which this estimator's header slack already covers.
    return 4 * ((len(name) // 4) + 1) + 16


def window_of(clips, start, span, budget=MAX_REPLY_BYTES):
    """Records for `clips[start:start + span]`, at most what fits a datagram.

    Takes the track's clip LIST rather than records already read, and reads
    three properties only for the clips inside the window. Reading the whole
    track and slicing afterwards costs three LOM property reads per clip on
    the track for every page: a 700-clip track paged to completion spent
    ~11,200 property reads to deliver ~700, all on Live's single callback
    thread. The handler still reports the track's true clip count, which is
    `len(clips)` and costs nothing.

    The HANDLER owns the window, not the client, for the reason `rack_paths`'
    `build_window` documents: only the sender knows the byte sizes, and a
    client-side window sized for short names serialises a track of long ones
    past the cap.

    A single oversized record is still returned, so every reply carries at
    least one and the client's paging loop always makes progress.

    Indexes rather than slices: `clips` is a Live list, and `arrangement.py`
    already relies on `len()` and `[i]` on it and on nothing else.
    """
    start = max(0, start)
    span = max(0, span)
    stop = min(len(clips), start + span)
    out = []
    used = 0
    for index in range(start, stop):
        record = clip_record(clips[index])
        cost = _record_bytes(record)
        if out and used + cost > budget:
            break
        out.append(record)
        used += cost
    return out


def arrangement_reply(track_index, start, total, records):
    """`(track, start, total, *(name, start_time, length, looping, loop_start, loop_end))`.

    `track` and `start` lead because the client's request table keys on the
    leading arguments of the request and the reply alike. `total` is the
    track's real clip count, not the window's: the client pages until it has
    them all, and a window-sized total would stop it early and present a
    truncated timeline as a complete one.
    """
    flat = [field for record in records for field in record]
    return (track_index, start, total, *flat)


def identity_reply(track_index, index, clip):
    """`(track, index, name, start_time, length, looping, loop_start, loop_end)` for ONE clip.

    A separate address from the map, modelled on
    `/live/mixingpal/get/device/identity` and existing for the same reason.
    The map's key is `(track, start)`, so an identity read phrased as a
    span-1 page collides with a span-48 page of the same track whenever
    `index == start`: the second registrant joins the first and takes its
    reply, and a page expecting 48 records receives one. A distinct address
    cannot collide, and it reads one clip instead of rescanning a track.
    """
    return (track_index, index, *clip_record(clip))


def timeline_fingerprint_reply(track_index, clips):
    """`(track, total, digest)` for one coherent arrangement timeline.

    The map pages records, so a same-count reorder between pages used to be
    indistinguishable from a stable list. One fingerprint before and after a
    read makes that mutation observable without putting a whole-track scan in
    every page handler. The digest covers the same fields the map returns.
    """
    records = tuple(clip_record(clips[index]) for index in range(len(clips)))
    digest = hashlib.sha256(repr(records).encode("utf-8")).hexdigest()
    return (track_index, len(clips), digest)


def cue_points_reply(cue_points, budget=MAX_REPLY_BYTES):
    """`(total, *(name, time))`, cut to one datagram.

    Bounded rather than paged. The poll loop fires this every five seconds
    into the mirror and never awaits a reply, so there is nothing to drive a
    paging loop; upstream's `/live/song/get/cue_points` is unbounded instead,
    and a set with enough locators makes its sendto raise, which reaches the
    client as silence -- indistinguishable from "this set has no locators",
    every five seconds, forever.

    `total` is the true locator count, not the number of records carried, so
    the client can say that the SECTIONS line is a subset rather than
    presenting it as the whole structure.
    """
    total = len(cue_points)
    out = [total]
    used = 0
    for cue in cue_points:
        record = (str(cue.name)[:NAME_CAP], float(cue.time))
        cost = _record_bytes(record)
        if used + cost > budget:
            break
        out.extend(record)
        used += cost
    return tuple(out)
