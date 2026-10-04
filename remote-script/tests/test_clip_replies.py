"""Unit tests for mixingpal/clip_replies.py.

The module is loaded by file path rather than imported as
`mixingpal.clip_replies`, for the same reason `test_rack_paths.py` does it:
`mixingpal/__init__.py` imports every handler, and those reach
`ableton.v2.control_surface`, which exists only inside Live.

What these pin is a cross-language contract. `src-tauri/src/tools/clip_notes.rs`
decodes both replies positionally, so the order of a note's five attributes and
the position of the echoed window ordinal cannot change on one side alone.

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "clip_replies.py")
_SPEC = importlib.util.spec_from_file_location("clip_replies", _TARGET)
clip_replies = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(clip_replies)


class FakeNote(object):
    def __init__(self, pitch, start_time, duration, velocity, mute, probability=1.0):
        self.pitch = pitch
        self.start_time = start_time
        self.duration = duration
        self.velocity = velocity
        self.mute = mute
        self.probability = probability


class NumNotesReplyTests(unittest.TestCase):
    def test_the_two_indices_lead_and_the_count_follows(self):
        notes = [FakeNote(60, 0.0, 0.5, 100, False) for _ in range(3)]
        self.assertEqual(clip_replies.num_notes_reply(2, 1, notes), (2, 1, 3))

    def test_a_clip_with_no_notes_reports_zero_rather_than_nothing(self):
        # Zero notes and no reply are different facts on the client side:
        # zero sizes one window, silence falls back to probing the whole clip.
        self.assertEqual(clip_replies.num_notes_reply(0, 0, []), (0, 0, 0))


class NotesWindowReplyTests(unittest.TestCase):
    def test_the_window_ordinal_is_echoed_unchanged_after_the_two_indices(self):
        # The ordinal is what makes two windows of one clip distinct keys in
        # the client's request table. Live never interprets it.
        reply = clip_replies.notes_window_reply(2, 1, 7, [])
        self.assertEqual(reply, (2, 1, 7))

    def test_each_note_flattens_to_six_attributes_in_the_order_rust_reads(self):
        # decode_notes in src-tauri/src/tools/clip_notes.rs reads
        # pitch, start, duration, velocity, mute, probability -- positionally.
        # A swap here produces notes that are plausible and wrong.
        notes = [FakeNote(60, 0.0, 0.5, 100, False),
                 FakeNote(64, 1.0, 0.25, 80, True, 0.3)]
        self.assertEqual(
            clip_replies.notes_window_reply(2, 1, 0, notes),
            (2, 1, 0,
             60, 0.0, 0.5, 100, False, 1.0,
             64, 1.0, 0.25, 80, True, 0.3),
        )

    def test_the_body_is_always_a_multiple_of_six(self):
        # The client refuses a body that is not, so an off-by-one here would
        # make the whole window decode as malformed rather than as wrong data.
        for count in range(0, 4):
            notes = [FakeNote(60, 0.0, 0.5, 100, False) for _ in range(count)]
            body = clip_replies.notes_window_reply(0, 0, 0, notes)[3:]
            self.assertEqual(len(body) % 6, 0)
            self.assertEqual(len(body), count * 6)


if __name__ == "__main__":
    unittest.main()
