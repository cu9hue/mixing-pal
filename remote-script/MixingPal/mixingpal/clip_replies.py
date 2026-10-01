"""Reply shapes for the clip endpoints, in a module Live imports cannot reach.

`clip_notes.py` reaches `ableton.v2.control_surface` through its handler base
class, so nothing in it can be imported outside Live. The two reply tuples are
the one part worth pinning: the client decodes them positionally, so the ORDER
of a note's five attributes and the position of the echoed window ordinal are a
contract between this file and `src-tauri/src/tools/clip_notes.rs`. Getting
either wrong produces notes that are plausible and wrong.

Same reason `rack_paths.py` exists, and tested the same way -- see
`remote-script/tests/test_clip_replies.py`.
"""


import hashlib
import json

def num_notes_reply(track_index, clip_index, notes):
    """`(track, clip, count)` for `/live/clip/get/num_notes`.

    The two indices lead because the client's request table keys on the
    leading arguments of the request and the reply alike.
    """
    return (track_index, clip_index, len(notes))


def notes_window_reply(track_index, clip_index, window, notes):
    """`(track, clip, window, *attributes)` for `/live/clip/get/notes_window`.

    `window` is the client's own ordinal, echoed unchanged and never
    interpreted here. It is what makes two windows of one clip distinct keys,
    so a window the client gave up on cannot come back late and resolve a
    different window's request.

    Five attributes per note, in the order the client reads them back.
    """
    attributes = []
    for note in notes:
        attributes.extend(_note_attributes(note))
    return (track_index, clip_index, window, *attributes)


def session_clips_reply(track_index, start, limit, slots):
    end = min(len(slots), start + min(limit, 16))
    names = tuple(str(slot.clip.name)[:120] if slot.clip else None
                  for slot in slots[start:end])
    return (track_index, start, len(slots), *names)


def session_fingerprint_reply(track_index, slots):
    names = tuple(str(slot.clip.name)[:120] if slot.clip else None for slot in slots)
    digest = hashlib.sha256(json.dumps(names, separators=(",", ":")).encode("utf-8")).hexdigest()
    return (track_index, len(slots), digest)


def _note_attributes(note):
    return (note.pitch, note.start_time, note.duration, note.velocity, note.mute)


def source_note_range(clip):
    """Absolute clip beats covering markers and the enabled loop, not duration."""
    start, end = float(clip.start_marker), float(clip.end_marker)
    if clip.looping:
        start = min(start, float(clip.loop_start))
        end = max(end, float(clip.loop_end))
    return start, end


def session_snapshot_reply(track_index, clip_index, clip, notes):
    length = float(clip.length)
    looping = bool(clip.looping)
    start, end = (float(clip.loop_start), float(clip.loop_end)) if looping else (0.0, 0.0)
    metadata = (length, looping, start, end, float(clip.start_marker), float(clip.end_marker))
    digest = hashlib.sha256(json.dumps(metadata, separators=(",", ":")).encode("utf-8"))
    for note in notes:
        digest.update(json.dumps(_note_attributes(note), separators=(",", ":")).encode("utf-8"))
    return (track_index, clip_index, len(notes), digest.hexdigest(), *metadata)
