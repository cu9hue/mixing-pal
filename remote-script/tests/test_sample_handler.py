import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch


def load_handler():
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("sample_handler_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    package = ModuleType("sample_handler_test.mixingpal")
    package.__path__ = []
    with patch.dict(sys.modules, {base.__name__: base, package.__name__: package}):
        for name in ("rack_paths", "sample_replies", "sample"):
            qualified = "sample_handler_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
        return module.SampleHandler


ADDRESS = "/live/mixingpal/get/sample"
FRAMES = "/live/mixingpal/get/sample/frames"


def audio_clip(name):
    return SimpleNamespace(
        is_audio_clip=True, file_path="/S/" + name, sample_rate=44100.0, sample_length=8000,
        warping=True, warp_mode=0, gain_display_string="0.00 dB", pitch_coarse=0, pitch_fine=0.0,
        looping=False, muted=False, start_marker=0.0, loop_start=0.0, loop_end=8.0,
        start_time=0.0, end_time=4.0, beat_to_sample_time=lambda b: b * 1000.0)


def simpler(name):
    sample = SimpleNamespace(file_path="/S/" + name, sample_rate=44100.0, length=100,
                             start_marker=0, end_marker=99, warping=False, warp_mode=0,
                             slices=[], gain_display_string=lambda: "0.00 dB")
    return SimpleNamespace(class_name="OriginalSimpler", multi_sample_mode=False,
                           playback_mode=1, sample=sample, parameters=[])


def pad(note, device):
    chain = SimpleNamespace(devices=[device], name="pad", mute=False, solo=False)
    return SimpleNamespace(note=note, name="pad", mute=False, solo=False, chains=[chain])


class GroupTrack:
    clip_slots = []

    @property
    def arrangement_clips(self):
        raise RuntimeError("Main, Group and Return Tracks have no arrangement clips")


class SampleHandlerTests(unittest.TestCase):
    def setUp(self):
        drum_rack = SimpleNamespace(can_have_drum_pads=True, drum_pads=[pad(36, simpler("Kick.wav")), pad(38, simpler("Snare.wav"))])
        audio = SimpleNamespace(
            clip_slots=[SimpleNamespace(has_clip=True, clip=audio_clip("Vox.wav")), SimpleNamespace(has_clip=False, clip=None)],
            arrangement_clips=[audio_clip("Vox take.wav")],
            devices=[drum_rack],
        )
        handler = object.__new__(load_handler())
        handler.song = SimpleNamespace(tracks=[audio, GroupTrack()], tempo=120.0)
        callbacks = {}
        handler.osc_server = SimpleNamespace(add_handler=callbacks.__setitem__)
        handler.init_api()
        self.sample = callbacks[ADDRESS]
        self.frames = callbacks[FRAMES]

    def test_a_session_slot_answers_its_clip(self):
        reply = self.sample((0, 0, "0"))
        self.assertEqual(reply[:5], (0, 0, "0", "ok", "/S/Vox.wav"))

    def test_an_arrangement_index_answers_its_clip(self):
        self.assertEqual(self.sample((0, 1, "0"))[4], "/S/Vox take.wav")

    def test_a_drum_pad_path_reaches_its_own_simpler(self):
        self.assertEqual(self.sample((0, 2, "0.0.0"))[4], "/S/Kick.wav")
        self.assertEqual(self.sample((0, 2, "0.1.0"))[4], "/S/Snare.wav")

    def test_targets_that_do_not_exist_are_named(self):
        self.assertEqual(self.sample((0, 0, "1")), (0, 0, "1", "empty_slot"))
        self.assertEqual(self.sample((0, 0, "7")), (0, 0, "7", "no_such_target"))
        self.assertEqual(self.sample((0, 1, "3")), (0, 1, "3", "no_such_target"))
        self.assertEqual(self.sample((0, 2, "0.5.0")), (0, 2, "0.5.0", "no_such_target"))
        self.assertEqual(self.sample((0, 2, "0.1")), (0, 2, "0.1", "no_such_target"))
        self.assertEqual(self.sample((0, 0, "-1")), (0, 0, "-1", "no_such_target"))

    def test_a_group_track_has_no_arrangement_sample(self):
        self.assertEqual(self.sample((1, 1, "0")), (1, 1, "0", "no_such_target"))

    def test_malformed_requests_get_no_reply_and_never_raise(self):
        for params in [(), (0, 0), (9, 0, "0"), ("x", 0, "0"), (0, 7, "0")]:
            with self.subTest(params=params):
                self.assertIsNone(self.sample(params))

    def test_frames_map_a_session_or_arrangement_clip(self):
        self.assertEqual(self.frames((0, 0, "0", "0,2")), (0, 0, "0", "0,2", "ok", 8000, 2, 0, 2000))
        self.assertEqual(self.frames((0, 1, "0", "1")), (0, 1, "0", "1", "ok", 8000, 1, 1000))

    def test_frames_name_a_missing_clip_and_refuse_a_device(self):
        self.assertEqual(self.frames((0, 0, "1", "0"))[-1], "empty_slot")
        self.assertEqual(self.frames((0, 0, "7", "0"))[-1], "no_such_target")
        self.assertEqual(self.frames((0, 2, "0.0.0", "0"))[-1], "no_such_target")
        self.assertEqual(self.frames((1, 1, "0", "0"))[-1], "no_such_target")

    def test_malformed_frames_requests_get_no_reply_and_never_raise(self):
        for params in ((), (0, 0, "0"), (0, "x", "0", "0"), (9, 0, "0", "0"), (0, 5, "0", "0")):
            self.assertIsNone(self.frames(params), params)


if __name__ == "__main__":
    unittest.main()
