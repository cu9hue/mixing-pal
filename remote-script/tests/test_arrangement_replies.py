"""Unit tests for mixingpal/arrangement_replies.py.

The module is loaded by file path rather than imported as
`mixingpal.arrangement_replies`, for the same reason `test_clip_replies.py`
does it: `mixingpal/__init__.py` imports every handler, and those reach
`ableton.v2.control_surface`, which exists only inside Live.

What these pin is a cross-language contract. `src-tauri/src/tools/arrangement.rs`
decodes the reply positionally, so the order of a clip's three fields and the
position of the echoed header are a contract between this file and that one.

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "arrangement_replies.py")
_SPEC = importlib.util.spec_from_file_location("arrangement_replies", _TARGET)
arrangement_replies = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(arrangement_replies)

NAME_CAP = arrangement_replies.NAME_CAP
arrangement_reply = arrangement_replies.arrangement_reply
clips_of = arrangement_replies.clips_of
window_of = arrangement_replies.window_of

# Loaded by file path, not `from MixingPal.mixingpal.clip_replies import ...`,
# for the same reason arrangement_replies is above: mixingpal/__init__.py
# imports handlers that reach ableton.v2.control_surface, which exists only
# inside Live. See test_clip_replies.py, which loads it the same way.
_CLIP_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "clip_replies.py")
_CLIP_SPEC = importlib.util.spec_from_file_location("clip_replies", _CLIP_TARGET)
clip_replies = importlib.util.module_from_spec(_CLIP_SPEC)
_CLIP_SPEC.loader.exec_module(clip_replies)

notes_window_reply = clip_replies.notes_window_reply
num_notes_reply = clip_replies.num_notes_reply


class FakeClip:
    def __init__(self, name, start_time, length):
        self.name = name
        self.start_time = start_time
        self.length = length


class FakeTrack:
    def __init__(self, clips):
        self.arrangement_clips = clips


class ClipsOf(unittest.TestCase):
    def test_returns_name_start_and_length_in_timeline_order(self):
        track = FakeTrack([FakeClip("Verse", 32.0, 64.0), FakeClip("Fill", 60.0, 4.0)])
        self.assertEqual(
            clips_of(track),
            [("Verse", 32.0, 64.0), ("Fill", 60.0, 4.0)],
        )

    def test_a_track_with_nothing_on_the_timeline_is_empty_not_an_error(self):
        # Normal early in the writing phase, and the client must be able to
        # tell it apart from a track that did not answer.
        self.assertEqual(clips_of(FakeTrack([])), [])

    def test_a_long_name_is_capped_on_the_wire(self):
        track = FakeTrack([FakeClip("x" * 500, 0.0, 4.0)])
        self.assertEqual(len(clips_of(track)[0][0]), NAME_CAP)


class WindowOf(unittest.TestCase):
    def test_returns_at_most_span_records_from_start(self):
        entries = [("a", 0.0, 4.0), ("b", 4.0, 4.0), ("c", 8.0, 4.0)]
        self.assertEqual(window_of(entries, 1, 2, budget=8960), entries[1:3])

    def test_a_start_past_the_end_returns_nothing_rather_than_raising(self):
        self.assertEqual(window_of([("a", 0.0, 4.0)], 5, 2, budget=8960), [])

    def test_the_budget_cuts_the_window_short(self):
        # The sender owns the window, because only it knows the byte sizes.
        # A reply past the datagram cap makes Live's sendto raise and the
        # client receives nothing at all.
        entries = [("x" * 100, float(i), 4.0) for i in range(50)]
        got = window_of(entries, 0, 50, budget=400)
        self.assertGreater(len(got), 0)
        self.assertLess(len(got), 50)

    def test_one_oversized_record_is_still_returned(self):
        # Every reply carries at least one record, or the client's paging
        # loop cannot make progress.
        entries = [("x" * 500, 0.0, 4.0)]
        self.assertEqual(len(window_of(entries, 0, 10, budget=10)), 1)


class ArrangementReply(unittest.TestCase):
    def test_flattens_records_after_the_echoed_header(self):
        reply = arrangement_reply(2, 1, 7, [("Verse", 32.0, 64.0)])
        self.assertEqual(reply, (2, 1, 7, "Verse", 32.0, 64.0))

    def test_the_header_carries_the_true_total_not_the_window_size(self):
        # The client pages until it has `total`; reporting the window size
        # would stop it after one page and silently truncate the timeline.
        reply = arrangement_reply(0, 0, 40, [("a", 0.0, 4.0)])
        self.assertEqual(reply[2], 40)


class FakeNote:
    def __init__(self, pitch, start_time):
        self.pitch = pitch
        self.start_time = start_time
        self.duration = 0.5
        self.velocity = 100
        self.mute = False


class ArrangementNotesShareTheSessionShape(unittest.TestCase):
    def test_the_note_reply_is_byte_identical_to_the_session_one(self):
        # The Rust decoder is reused rather than copied, and it reads these
        # positionally. If the two shapes ever diverge, the arrangement read
        # returns notes that are plausible and wrong.
        notes = [FakeNote(60, 0.0), FakeNote(64, 1.0)]
        self.assertEqual(
            notes_window_reply(2, 7, 3, notes),
            (2, 7, 3, 60, 0.0, 0.5, 100, False, 64, 1.0, 0.5, 100, False),
        )

    def test_the_count_reply_is_byte_identical_to_the_session_one(self):
        self.assertEqual(num_notes_reply(1, 4, [FakeNote(60, 0.0)]), (1, 4, 1))


if __name__ == "__main__":
    unittest.main()
