import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace
import unittest


def load():
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    package = ModuleType("sample_test")
    package.__path__ = []
    sys.modules["sample_test"] = package
    for name in ("rack_paths", "sample_replies"):
        qualified = "sample_test." + name
        spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
        module = importlib.util.module_from_spec(spec)
        sys.modules[qualified] = module
        spec.loader.exec_module(module)
    return module


sr = load()
KEY = (3, sr.ARRANGEMENT, "0")


def clip(**kw):
    """A warped audio clip: 1000 frames per beat, 44.1 kHz."""
    base = dict(
        is_audio_clip=True, file_path="/Users/someone/Samples/Vox/Lead Vox.wav",
        sample_rate=44100.0, sample_length=16000, warping=True, warp_mode=4,
        gain_display_string="0.00 dB", pitch_coarse=9, pitch_fine=0.0,
        looping=False, muted=False, start_marker=0.0, loop_start=0.0, loop_end=16.0,
        start_time=152.0, end_time=156.0,
        beat_to_sample_time=lambda b: b * 1000.0,
    )
    base.update(kw)
    return SimpleNamespace(**base)


class Raises:
    """A clip whose named property raises, as Live does for a stale object."""
    def __init__(self, inner, broken):
        self._inner, self._broken = inner, broken

    def __getattr__(self, name):
        if name == self._broken:
            raise RuntimeError("stale")
        return getattr(self._inner, name)


class PlayedIntervalTests(unittest.TestCase):
    def test_an_unlooped_placement_plays_from_the_clip_start(self):
        self.assertEqual(sr.played_intervals(False, 0.0, 0.0, 16.0, 4.0), [(0.0, 4.0)])

    def test_a_short_placement_ends_before_the_first_wrap(self):
        # The review's example: loop [0,8), marker 4, a 2-beat placement.
        self.assertEqual(sr.played_intervals(True, 4.0, 0.0, 8.0, 2.0), [(4.0, 6.0)])

    def test_passes_through_the_whole_loop_merge(self):
        self.assertEqual(sr.played_intervals(True, 0.0, 0.0, 4.0, 16.0), [(0.0, 4.0)])

    def test_a_marker_before_the_loop_is_one_stretch(self):
        self.assertEqual(sr.played_intervals(True, 0.0, 2.0, 4.0, 10.0), [(0.0, 4.0)])

    def test_a_partial_wrap_keeps_playback_order(self):
        self.assertEqual(sr.played_intervals(True, 6.0, 0.0, 8.0, 4.0), [(6.0, 8.0), (0.0, 2.0)])

    def test_a_session_intro_before_the_loop_is_its_own_stretch(self):
        # Review finding 3: the intro plays once; only [2, 4) repeats.
        self.assertEqual(sr.played_intervals(True, 0.0, 2.0, 4.0), [(0.0, 2.0), (2.0, 4.0)])

    def test_a_session_loop_can_play_the_whole_loop(self):
        self.assertEqual(sr.played_intervals(True, 4.0, 0.0, 8.0), [(0.0, 8.0)])

    def test_a_marker_at_the_loop_end_has_no_region(self):
        self.assertIsNone(sr.played_intervals(True, 8.0, 0.0, 8.0, 4.0))

    def test_a_missing_value_has_no_region(self):
        self.assertIsNone(sr.played_intervals(None, 0.0, 0.0, 8.0, 4.0))
        self.assertIsNone(sr.played_intervals(True, None, 0.0, 8.0, 4.0))


class ClipReplyTests(unittest.TestCase):
    def test_a_warped_placement_maps_its_region_through_live(self):
        reply = sr.clip_reply(KEY, clip(), True, 135.0)
        self.assertEqual(reply[:4], KEY + ("ok",))
        self.assertEqual(reply[4:12], ("/Users/someone/Samples/Vox/Lead Vox.wav", 44100.0, 16000, True, 4, "0.00 dB", 9, 0.0))
        self.assertEqual(reply[12:17], (1, 0.0, 4.0, 0, 4000))
        self.assertEqual(reply[17:], (False, False, 0.0, 0.0, 16.0, 152.0, 156.0, 135.0))

    def test_an_unwarped_placement_converts_its_length_at_the_tempo(self):
        c = clip(warping=False, loop_end=0.5, start_time=0.0, end_time=4.0, sample_length=22050,
                 seconds_to_sample_time=lambda s: s * 44100.0)
        reply = sr.clip_reply(KEY, c, True, 120.0)
        # 4 beats at 120 BPM is 2 s, longer than the 0.5 s file: plays 0-0.5 s.
        self.assertEqual(reply[12:17], (1, 0.0, 0.5, 0, 22050))

    def test_a_session_clip_has_no_placement(self):
        reply = sr.clip_reply((3, sr.SESSION, "0"), clip(looping=True, start_marker=4.0, loop_end=8.0), False, 135.0)
        self.assertEqual(reply[12:17], (1, 0.0, 8.0, 0, 8000))
        self.assertEqual(reply[22:24], (None, None))

    def test_a_midi_clip_is_refused(self):
        self.assertEqual(sr.clip_reply(KEY, clip(is_audio_clip=False), True, 135.0), KEY + ("not_audio_clip",))

    def test_a_missing_marker_never_widens_the_region(self):
        reply = sr.clip_reply(KEY, Raises(clip(looping=True), "start_marker"), True, 135.0)
        self.assertEqual(reply[3], "ok")
        self.assertEqual(reply[12], 0)
        self.assertEqual(reply[4], "/Users/someone/Samples/Vox/Lead Vox.wav")

    def test_a_raising_setting_reads_as_nil(self):
        reply = sr.clip_reply(KEY, Raises(clip(), "gain_display_string"), True, 135.0)
        self.assertIsNone(reply[9])
        self.assertEqual(reply[12], 1)

    def test_a_raising_frame_conversion_leaves_no_region(self):
        def boom(_):
            raise RuntimeError("Cannot convert beat to sample time for unwarped clips.")
        reply = sr.clip_reply(KEY, clip(beat_to_sample_time=boom), True, 135.0)
        self.assertEqual(reply[12], 0)

    def test_frames_are_clamped_to_the_file(self):
        reply = sr.clip_reply(KEY, clip(end_time=200.0, loop_end=40.0), True, 135.0)
        self.assertEqual(reply[16], 16000)

    def test_a_path_too_long_for_a_datagram_is_named(self):
        reply = sr.clip_reply(KEY, clip(file_path="/" + "a" * 9000), True, 135.0)
        self.assertEqual(reply, KEY + ("path_too_long",))


def simpler(**kw):
    sample = SimpleNamespace(
        file_path="/Users/someone/Samples/Drums/Perc 2.wav", sample_rate=44100.0, length=1000,
        start_marker=0, end_marker=999, warping=False, warp_mode=0, slices=[100, 400],
        gain_display_string=lambda: "0.00 dB",
    )
    def param(name, value, lo=0.0, hi=1.0):
        return SimpleNamespace(name=name, value=value, min=lo, max=hi)
    base = dict(
        class_name="OriginalSimpler", multi_sample_mode=False, playback_mode=0, sample=sample,
        parameters=[param("S Start", 0.25), param("S Length", 0.5), param("S Loop On", 1.0),
                    param("S Loop Length", 0.2), param("Transpose", -3.0, -48.0, 48.0),
                    param("Detune", 12.0, -50.0, 50.0)],
    )
    base.update(kw)
    return SimpleNamespace(**base)


DKEY = (1, sr.DEVICE, "0.2.0")


class SimplerReplyTests(unittest.TestCase):
    def test_classic_start_and_length_narrow_the_markers(self):
        reply = sr.simpler_reply(DKEY, simpler())
        self.assertEqual(reply[3:12], ("ok", "/Users/someone/Samples/Drums/Perc 2.wav", 44100.0, 1000, False, 0, "0.00 dB", -3.0, 12.0))
        self.assertEqual(reply[12:17], (1, 250, 750, 250, 750))
        # S Loop Length 20 % of the played part, at its end.
        self.assertEqual(reply[17:], (0, 2, 650, 750))

    def test_one_shot_plays_between_the_markers(self):
        reply = sr.simpler_reply(DKEY, simpler(playback_mode=1))
        self.assertEqual(reply[12:17], (1, 0, 1000, 0, 1000))
        self.assertEqual(reply[17:], (1, 2, None, None))

    def test_slice_reports_the_region_slices_come_from(self):
        reply = sr.simpler_reply(DKEY, simpler(playback_mode=2))
        self.assertEqual(reply[12:17], (1, 0, 1000, 0, 1000))
        self.assertEqual(reply[17:19], (2, 2))

    def test_an_unreadable_start_or_mode_never_widens_the_region(self):
        # Review finding 2: without S Start, or without the mode, the
        # narrowed region is unknown; it must not become the whole sample.
        no_start = simpler()
        no_start.parameters = [p for p in no_start.parameters if p.name != "S Start"]
        self.assertEqual(sr.simpler_reply(DKEY, no_start)[12], 0)
        self.assertEqual(sr.simpler_reply(DKEY, simpler(playback_mode=None))[12], 0)

    def test_devices_that_are_not_a_readable_simpler_say_why(self):
        self.assertEqual(sr.simpler_reply(DKEY, simpler(sample=None)), DKEY + ("no_sample",))
        self.assertEqual(sr.simpler_reply(DKEY, simpler(multi_sample_mode=True)), DKEY + ("multisample_not_readable",))
        self.assertEqual(sr.simpler_reply(DKEY, simpler(class_name="MultiSampler")), DKEY + ("sampler_not_readable",))
        self.assertEqual(sr.simpler_reply(DKEY, simpler(class_name="Eq8")), DKEY + ("not_a_simpler",))


if __name__ == "__main__":
    unittest.main()
