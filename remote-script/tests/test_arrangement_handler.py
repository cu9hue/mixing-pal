import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


def load_handler():
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("arrangement_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    modules = {base.__name__: base}
    with patch.dict(sys.modules, modules):
        for name in ("arrangement_replies", "clip_replies", "arrangement"):
            qualified = "arrangement_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
        return module.ArrangementHandler


class GroupTrack:
    is_foldable = True

    @property
    def arrangement_clips(self):
        raise RuntimeError("Main, Group and Return Tracks have no arrangement clips")


class ArrangementHandlerTests(unittest.TestCase):
    def setUp(self):
        handler_type = load_handler()
        self.handler = object.__new__(handler_type)
        self.handler.song = SimpleNamespace(tracks=[GroupTrack()])
        self.callbacks = {}
        self.handler.osc_server = SimpleNamespace(add_handler=self.callbacks.__setitem__)
        self.handler.init_api()

    def test_group_timeline_is_empty_not_a_lost_reply(self):
        reply = self.callbacks["/live/mixingpal/get/arrangement"]((0, 0, 48))
        self.assertEqual(reply, (0, 0, 0))

    def test_group_fingerprint_is_stable_and_empty(self):
        callback = self.callbacks["/live/mixingpal/get/arrangement/fingerprint"]
        first = callback((0,))
        self.assertEqual(first[:2], (0, 0))
        self.assertEqual(len(first[2]), 64)
        self.assertEqual(callback((0,)), first)

    def test_group_clip_lookup_has_no_clip(self):
        for address, args in [
            ("/live/mixingpal/get/arrangement/identity", (0, 0)),
            ("/live/arrangement_clip/get/length", (0, 0)),
            ("/live/arrangement_clip/get/num_notes", (0, 0)),
            ("/live/arrangement_clip/get/notes_window", (0, 0, 0, 0, 128, 0, 4)),
        ]:
            with self.subTest(address=address):
                self.assertIsNone(self.callbacks[address](args))

    def test_invalid_track_still_does_not_claim_an_empty_timeline(self):
        self.assertIsNone(self.callbacks["/live/mixingpal/get/arrangement"]((1, 0, 48)))


    def test_source_snapshot_includes_offset_notes_and_detects_edits(self):
        for looping in (True, False):
            note = SimpleNamespace(pitch=60, start_time=8.0, duration=0.5, velocity=100, mute=False,
                                   probability=1.0)
            clip = SimpleNamespace(is_midi_clip=True, length=4.0, looping=looping,
                loop_start=8.0, loop_end=12.0, start_marker=8.0, end_marker=12.0,
                get_notes_extended=lambda pitch, count, start, span: [note] if start <= note.start_time < start + span else [])
            self.handler.song.tracks = [SimpleNamespace(is_foldable=False, arrangement_clips=[clip])]
            callback = self.callbacks["/live/arrangement_clip/get/num_notes"]
            first = callback((0, 0))
            self.assertEqual(first[2], 1)
            note.pitch = 64
            self.assertNotEqual(first[3], callback((0, 0))[3])

    def test_a_regular_track_error_is_not_relabelled_empty(self):
        self.handler.song.tracks[0].is_foldable = False
        with self.assertRaises(RuntimeError):
            self.callbacks["/live/mixingpal/get/arrangement"]((0, 0, 48))
