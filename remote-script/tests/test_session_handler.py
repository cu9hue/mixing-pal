"""Exercise session handlers without Live's control-surface runtime."""
import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


def load_handler():
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("session_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    with patch.dict(sys.modules, {base.__name__: base}):
        for name in ("clip_replies", "clip_notes"):
            qualified = "session_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
        return module.ClipNotesHandler


class GroupTrack:
    is_foldable = True
    @property
    def clip_slots(self):
        raise RuntimeError("group slots unavailable")


class SessionHandlerTests(unittest.TestCase):
    def setUp(self):
        self.handler = object.__new__(load_handler())
        self.callbacks = {}
        self.handler.osc_server = SimpleNamespace(add_handler=self.callbacks.__setitem__)
        self.handler.song = SimpleNamespace(tracks=[])
        self.handler.init_api()

    def test_audio_and_empty_slots_have_explicit_note_status(self):
        self.handler.song.tracks = [SimpleNamespace(clip_slots=[
            SimpleNamespace(clip=SimpleNamespace(is_midi_clip=False)),
            SimpleNamespace(clip=None)])]
        callback = self.callbacks["/live/clip/get/num_notes"]
        self.assertEqual(callback((0, 0)), (0, 0, "not_midi_clip"))
        self.assertEqual(callback((0, 1)), (0, 1, "empty_slot"))
        self.assertIsNone(callback((0, 2)))

    def test_session_pages_keep_audio_unnamed_and_empty_slot_indices(self):
        self.handler.song.tracks = [SimpleNamespace(is_foldable=False, clip_slots=[
            SimpleNamespace(clip=SimpleNamespace(name="audio", is_midi_clip=False)),
            SimpleNamespace(clip=None), SimpleNamespace(clip=SimpleNamespace(name=""))])]
        callback = self.callbacks["/live/mixingpal/get/session/clips"]
        self.assertEqual(callback((0, 0, 2)), (0, 0, 3, "audio", None))
        self.assertEqual(callback((0, 2, 2)), (0, 2, 3, ""))
        self.assertIsNone(callback((1, 0, 2)))

    def test_group_page_is_empty_without_reading_its_slots(self):
        self.handler.song.tracks = [GroupTrack()]
        callback = self.callbacks["/live/mixingpal/get/session/clips"]
        self.assertEqual(callback((0, 0, 16)), (0, 0, 0))

    def test_large_unicode_names_cannot_overfill_a_page(self):
        self.handler.song.tracks = [SimpleNamespace(is_foldable=False, clip_slots=[
            SimpleNamespace(clip=SimpleNamespace(name="😀" * 2000)) for _ in range(40)])]
        reply = self.callbacks["/live/mixingpal/get/session/clips"]((0, 0, 999))
        self.assertEqual(len(reply[3:]), 16)
        self.assertTrue(all(len(name) <= 120 for name in reply[3:]))
        root = str(Path(__file__).resolve().parents[1] / "MixingPal")
        with patch.object(sys, "path", [root, *sys.path]):
            from pythonosc.osc_message_builder import OscMessageBuilder
            builder = OscMessageBuilder("/live/mixingpal/get/session/clips")
            for value in reply:
                builder.add_arg(value)
            self.assertLess(len(builder.build().dgram), 9216)

    def test_note_snapshot_detects_same_count_note_and_loop_edits(self):
        note = SimpleNamespace(pitch=60, start_time=0.0, duration=0.5, velocity=100, mute=False)
        clip = SimpleNamespace(is_midi_clip=True, length=4.0, looping=True,
            loop_start=0.0, loop_end=4.0, get_notes_extended=lambda *_: [note])
        self.handler.song.tracks = [SimpleNamespace(clip_slots=[SimpleNamespace(clip=clip)])]
        callback = self.callbacks["/live/clip/get/num_notes"]
        first = callback((0, 0))
        self.assertEqual(first[2], 1)
        self.assertEqual(first[4:], (4.0, True, 0.0, 4.0))
        self.assertEqual(callback((0, 0)), first)
        note.pitch = 64
        second = callback((0, 0))
        self.assertNotEqual(first[3], second[3])
        clip.loop_start = 1.0
        third = callback((0, 0))
        self.assertNotEqual(second[3], third[3])
        self.assertEqual(third[4:], (4.0, True, 1.0, 4.0))

    def test_regular_track_errors_are_not_relabelled_empty(self):
        group = GroupTrack()
        group.is_foldable = False
        self.handler.song.tracks = [group]
        with self.assertRaises(RuntimeError):
            self.callbacks["/live/mixingpal/get/session/clips"]((0, 0, 16))
