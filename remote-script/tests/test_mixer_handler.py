import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as N
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "MixingPal"))
from pythonosc.osc_message_builder import OscMessageBuilder


def param(shown, state=0):
    return N(value=0.5, automation_state=state, str_for_value=lambda _value: shown)


def device(name, kind=2, active=True, cls="EQ Eight", rack=False):
    return N(name=name, can_have_chains=rack, is_active=active, type=kind, class_display_name=cls)


def mixer(volume="-6.0 dB", pan="C", sends=(), volume_state=0, pan_state=0):
    return N(volume=param(volume, volume_state), panning=param(pan, pan_state), sends=list(sends))


def track(name, group=None, output="Master", **kw):
    return N(name=name, mixer_device=mixer(**kw), is_grouped=group is not None, group_track=group,
             output_routing_type=N(display_name=output))


def handlers(song):
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("mixer_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    with patch.dict(sys.modules, {base.__name__: base}):
        for name in ("rack_paths", "device_range", "mixer"):
            qualified = "mixer_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
    handler = object.__new__(module.MixerHandler)
    handler.song = song
    callbacks = {}
    handler.osc_server = N(add_handler=callbacks.__setitem__)
    handler.init_api()
    return callbacks


def fits(address, reply):
    builder = OscMessageBuilder(address=address)
    for value in reply:
        builder.add_arg(value)
    return len(builder.build().dgram) <= 9216


class TrackMixerTests(unittest.TestCase):
    def test_sends_routing_group_and_automation_state(self):
        bus = track("Drums Bus")
        kick = track("Kick", group=bus, output="Drums Bus", volume_state=1,
                     sends=[param("-12.0 dB"), param("-inf dB", 2)])
        song = N(tracks=[bus, kick], return_tracks=[], master_track=None)
        reply = handlers(song)["/live/mixingpal/get/track_mixer"]((1,))
        self.assertEqual(reply, (1, "-6.0 dB", 1, "C", 0, "Drums Bus", 0, 2, "-12.0 dB", 0, "-inf dB", 2))

    def test_an_ungrouped_track_names_no_group_and_bad_scope_is_refused(self):
        song = N(tracks=[track("Pad")], return_tracks=[], master_track=None)
        callback = handlers(song)["/live/mixingpal/get/track_mixer"]
        self.assertEqual(callback((0,))[6], -1)
        for args in [(), (1,), (-1,), ("x",), (0, 1)]:
            self.assertIsNone(callback(args))


class ReturnAndMasterTests(unittest.TestCase):
    def test_a_return_reports_its_level_and_chain(self):
        reverb = track("A-Reverb", volume="0.0 dB")
        reverb.devices = [device("Reverb", cls="Reverb"), device("Off EQ", active=False)]
        song = N(tracks=[], return_tracks=[reverb], master_track=None)
        callback = handlers(song)["/live/mixingpal/get/return_mixer"]
        self.assertEqual(callback((0,)), (0, 1, "A-Reverb", "0.0 dB", 0, "C", 0, 2,
                                         "Reverb", False, True, 2, "Reverb", "Off EQ", False, False, 2, "EQ Eight"))
        for args in [(1,), (-1,), ()]:
            self.assertIsNone(callback(args))

    def test_a_long_master_chain_stops_at_the_datagram_and_still_counts_every_device(self):
        master = track("Main")
        master.devices = [device("L" + "😀" * 200) for _ in range(40)]
        reply = handlers(N(tracks=[], return_tracks=[], master_track=master))[
            "/live/mixingpal/get/master_mixer"](())
        self.assertEqual(reply[:6], ("Main", "-6.0 dB", 0, "C", 0, 40))
        self.assertTrue(fits("/live/mixingpal/get/master_mixer", reply))
        self.assertEqual((len(reply) - 6) % 5, 0)
        self.assertLess((len(reply) - 6) // 5, 40)


if __name__ == "__main__":
    unittest.main()
