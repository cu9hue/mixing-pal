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
