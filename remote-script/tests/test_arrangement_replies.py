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
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "arrangement_replies.py")
_SPEC = importlib.util.spec_from_file_location("arrangement_replies", _TARGET)
arrangement_replies = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(arrangement_replies)

NAME_CAP = arrangement_replies.NAME_CAP
MAX_REPLY_BYTES = arrangement_replies.MAX_REPLY_BYTES
arrangement_reply = arrangement_replies.arrangement_reply
clip_record = arrangement_replies.clip_record
cue_points_reply = arrangement_replies.cue_points_reply
identity_reply = arrangement_replies.identity_reply
window_of = arrangement_replies.window_of

# The vendored pythonosc, which is what actually serialises a reply inside
# Live. Imported as a package rather than by file path because its builder
# imports its own siblings; it reaches nothing under `abletonosc/`, so it
# loads fine outside Live. Used below to measure what a record really costs
# instead of recomputing it, so the test cannot repeat the estimator's own
# mistake.
sys.path.insert(0, os.path.join(_HERE, "..", "MixingPal"))
from pythonosc.osc_message_builder import OscMessageBuilder  # noqa: E402


def encoded_arg_bytes(fields):
    """Bytes `pythonosc` writes for `fields` themselves.

    The datagram less its address block and its type-tag block: those two
    are the header, and `HEADER_SLACK` in `src-tauri/src/osc/budget.rs`
    covers them. What is left is the variable part the estimators above are
    trying to bound.
    """
    builder = OscMessageBuilder(address="/x")
    for arg in fields:
        builder.add_arg(arg)
    address = 4 * ((len("/x") // 4) + 1)
    tags = 4 * (((1 + len(fields)) // 4) + 1)
    return len(builder.build().dgram) - address - tags

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


class ExplodingClip(object):
    """Fails the test if anything reads its properties.

    `window_of` used to read every clip on the track and slice afterwards,
    which cost three LOM property reads per clip per page. This is how the
    test says "the clips outside the window were never touched".
    """

    def __init__(self, case):
        self._case = case

    def __getattr__(self, attr):
        self._case.fail("a clip outside the window was read: %s" % attr)


class ClipRecord(unittest.TestCase):
    def test_returns_name_start_and_length_together(self):
        self.assertEqual(
            clip_record(FakeClip("Verse", 32.0, 64.0)),
            ("Verse", 32.0, 64.0),
        )

    def test_a_long_name_is_capped_on_the_wire(self):
        self.assertEqual(len(clip_record(FakeClip("x" * 500, 0.0, 4.0))[0]), NAME_CAP)


class WindowOf(unittest.TestCase):
    def clips(self, count):
        return [FakeClip("c%d" % i, float(i) * 4.0, 4.0) for i in range(count)]

    def test_returns_at_most_span_records_from_start(self):
        self.assertEqual(
            window_of(self.clips(3), 1, 2, budget=MAX_REPLY_BYTES),
            [("c1", 4.0, 4.0), ("c2", 8.0, 4.0)],
        )

    def test_a_track_with_nothing_on_the_timeline_is_empty_not_an_error(self):
        # Normal early in the writing phase, and the client must be able to
        # tell it apart from a track that did not answer.
        self.assertEqual(window_of(FakeTrack([]).arrangement_clips, 0, 48), [])

    def test_a_start_past_the_end_returns_nothing_rather_than_raising(self):
        self.assertEqual(window_of(self.clips(1), 5, 2, budget=MAX_REPLY_BYTES), [])

    def test_only_the_clips_inside_the_window_are_read(self):
        # The whole point of taking the clip list rather than a list of
        # records: a 700-clip track paged to completion cost ~11,200 property
        # reads to deliver ~700, on Live's single callback thread.
        clips = [ExplodingClip(self) for _ in range(20)]
        clips[5] = FakeClip("Verse", 32.0, 8.0)
        clips[6] = FakeClip("Fill", 40.0, 4.0)
        self.assertEqual(
            window_of(clips, 5, 2),
            [("Verse", 32.0, 8.0), ("Fill", 40.0, 4.0)],
        )

    def test_the_budget_cuts_the_window_short(self):
        # The sender owns the window, because only it knows the byte sizes.
        # A reply past the datagram cap makes Live's sendto raise and the
        # client receives nothing at all.
        clips = [FakeClip("x" * 100, float(i), 4.0) for i in range(50)]
        got = window_of(clips, 0, 50, budget=400)
        self.assertGreater(len(got), 0)
        self.assertLess(len(got), 50)

    def test_one_oversized_record_is_still_returned(self):
        # Every reply carries at least one record, or the client's paging
        # loop cannot make progress.
        self.assertEqual(len(window_of([FakeClip("x" * 500, 0.0, 4.0)], 0, 10, budget=10)), 1)


class RecordBytes(unittest.TestCase):
    def test_the_estimate_covers_a_multi_byte_name(self):
        # Three emoji are three codepoints and twelve UTF-8 bytes, and
        # pythonosc writes the bytes. Counting codepoints under-counted this
        # record by enough to pack a page past the cap, and past the cap
        # Live's sendto raises and the client receives nothing at all.
        record = clip_record(FakeClip("\U0001F3B9\U0001F3B9\U0001F3B9", 32.0, 8.0))
        self.assertGreaterEqual(
            arrangement_replies._record_bytes(record),
            encoded_arg_bytes(record),
        )

    def test_the_estimate_covers_a_full_page_of_multi_byte_names(self):
        # What the cap actually protects: a whole window, not one record.
        clips = [FakeClip("é" * NAME_CAP, float(i), 4.0) for i in range(48)]
        window = window_of(clips, 0, 48)
        estimate = sum(arrangement_replies._record_bytes(r) for r in window)
        encoded = encoded_arg_bytes([f for r in window for f in r])
        self.assertLessEqual(estimate, MAX_REPLY_BYTES)
        self.assertGreaterEqual(estimate, encoded)

    def test_the_estimate_covers_a_cue_point_record(self):
        self.assertGreaterEqual(
            arrangement_replies._record_bytes(("中文セク", 64.0)),
            encoded_arg_bytes(("中文セク", 64.0)),
        )


class ArrangementReply(unittest.TestCase):
    def test_flattens_records_after_the_echoed_header(self):
        reply = arrangement_reply(2, 1, 7, [("Verse", 32.0, 64.0)])
        self.assertEqual(reply, (2, 1, 7, "Verse", 32.0, 64.0))

    def test_the_header_carries_the_true_total_not_the_window_size(self):
        # The client pages until it has `total`; reporting the window size
        # would stop it after one page and silently truncate the timeline.
        reply = arrangement_reply(0, 0, 40, [("a", 0.0, 4.0)])
        self.assertEqual(reply[2], 40)


class IdentityReply(unittest.TestCase):
    def test_echoes_the_key_then_the_clip_s_three_fields(self):
        # A separate address from the map, so an identity read can never
        # join a span-48 page and take its reply. The Rust decoder reads
        # these five positionally.
        self.assertEqual(
            identity_reply(2, 7, FakeClip("Verse", 32.0, 64.0)),
            (2, 7, "Verse", 32.0, 64.0),
        )

    def test_an_unnamed_clip_still_carries_its_position(self):
        # Unnamed is the normal case on the timeline, and position is what
        # the bracket actually compares.
        self.assertEqual(identity_reply(0, 0, FakeClip("", 28.0, 4.0)), (0, 0, "", 28.0, 4.0))


class FakeCuePoint(object):
    def __init__(self, name, time):
        self.name = name
        self.time = time


class CuePointsReply(unittest.TestCase):
    def test_the_total_leads_and_the_pairs_follow(self):
        reply = cue_points_reply([FakeCuePoint("Intro", 0.0), FakeCuePoint("Drop", 64.0)])
        self.assertEqual(reply, (2, "Intro", 0.0, "Drop", 64.0))

    def test_a_set_with_no_locators_answers_rather_than_going_silent(self):
        # Zero locators is a real answer, and the client must be able to
        # tell it apart from a reply Live could not send.
        self.assertEqual(cue_points_reply([]), (0,))

    def test_the_total_stays_true_when_the_records_are_cut(self):
        # This is the whole reason the total leads: upstream's unbounded
        # handler overfills the datagram, sendto raises, and the client sees
        # nothing at all -- indistinguishable from a set with no locators.
        cues = [FakeCuePoint("Section %d" % i, float(i) * 16.0) for i in range(500)]
        reply = cue_points_reply(cues)
        self.assertEqual(reply[0], 500)
        self.assertLess((len(reply) - 1) // 2, 500)
        self.assertLessEqual(encoded_arg_bytes(reply), MAX_REPLY_BYTES)

    def test_a_long_locator_name_is_capped_on_the_wire(self):
        reply = cue_points_reply([FakeCuePoint("x" * 500, 0.0)])
        self.assertEqual(len(reply[1]), NAME_CAP)


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
