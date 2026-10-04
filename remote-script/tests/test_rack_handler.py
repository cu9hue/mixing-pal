import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as N
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "MixingPal"))
from pythonosc.osc_message_builder import OscMessageBuilder


def handler_for(rack):
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("rack_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    with patch.dict(sys.modules, {base.__name__: base}):
        for name in ("rack_paths", "rack"):
            qualified = "rack_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
    handler = object.__new__(module.RackHandler)
    handler.song = N(tracks=[N(devices=[rack])])
    callbacks = {}
    handler.osc_server = N(add_handler=callbacks.__setitem__)
    handler.init_api()
    return callbacks


class RackHandlerTests(unittest.TestCase):
    def test_both_offsets_are_echoed_and_device_names_continue_at_the_requested_index(self):
        chain = N(name="Chain", mute=False, solo=False,
                  devices=[N(name="Device%d" % i, can_have_chains=False, is_active=True, type=2, class_display_name="X") for i in range(40)])
        rack = N(name="Rack", chains=[chain], can_have_chains=True, parameters=[])
        callback = handler_for(rack)["/live/mixingpal/get/rack/chains_range"]
        reply = callback((0, "0", 0, 32, 1))
        self.assertEqual(reply[:6], (0, "0", 0, 32, 1, 1))
        self.assertEqual(reply[11:13], (40, 8))
        self.assertEqual(reply[13::5], tuple("Device%d" % i for i in range(32, 40)))
        self.assertEqual(callback((0, "0", 1, 32, 1)), (0, "0", 1, 32, 1, 1))
        beyond = callback((0, "0", 0, 99, 1))
        self.assertEqual(beyond[11:13], (40, 0))

    def test_long_names_fit_the_actual_osc_datagram_on_every_device_page(self):
        chain = N(name="😀" * 200, mute=False, solo=False,
                  devices=[N(name=str(i) + "😀" * 200, can_have_chains=False, is_active=True, type=2, class_display_name="X") for i in range(40)])
        rack = N(name="Rack", chains=[chain], can_have_chains=True, parameters=[])
        address = "/live/mixingpal/get/rack/chains_range"
        callback = handler_for(rack)[address]
        offset = 0
        while offset < 40:
            reply = callback((0, "0", 0, offset, 32))
            builder = OscMessageBuilder(address=address)
            for field in reply:
                builder.add_arg(field)
            self.assertLessEqual(len(builder.build().dgram), 9216)
            self.assertGreater(reply[12], 0)
            offset += reply[12]
        self.assertEqual(offset, 40)

    def test_legacy_rack_chain_reply_keeps_its_original_header(self):
        rack = N(name="Rack", chains=[], can_have_chains=True, parameters=[])
        self.assertEqual(handler_for(rack)["/live/mixingpal/get/rack/chains"]((0, "0", 0, 32)),
                         (0, "0", 0, 0, 1))

    def test_fingerprint_detects_same_count_chain_and_device_edits(self):
        chains = [N(name="Chain%d" % i, mute=False, solo=False,
                    devices=[N(name="Device%d" % j, can_have_chains=False, is_active=True, type=2,
                               class_display_name="X") for j in range(40)])
                  for i in range(64)]
        rack = N(name="Rack", chains=chains, can_have_chains=True, parameters=[])
        callbacks = handler_for(rack)
        fingerprint = callbacks["/live/mixingpal/get/rack/fingerprint"]
        before = fingerprint((0, "0"))
        self.assertEqual(before[:3], (0, "0", 64))
        self.assertEqual(len(before[3]), 64)
        self.assertEqual(before, fingerprint((0, "0")))
        page = callbacks["/live/mixingpal/get/rack/chains_range"]
        self.assertEqual(page((0, "0", 0, 0, 1))[6], "Chain0")
        chains[0], chains[32] = chains[32], chains[0]
        self.assertEqual(page((0, "0", 32, 0, 1))[6], "Chain0")
        self.assertNotEqual(before, fingerprint((0, "0")))
        for mutate in [lambda: setattr(chains[0].devices[39], "name", "renamed"),
                       lambda: setattr(chains[0].devices[39], "can_have_chains", True),
                       lambda: setattr(chains[0], "mute", True),
                       lambda: setattr(chains[0], "solo", True),
                       lambda: setattr(rack, "name", "another rack")]:
            before = fingerprint((0, "0"))
            mutate()
            self.assertNotEqual(before, fingerprint((0, "0")))

    def test_fingerprint_handles_empty_nonrack_and_unreadable_paths(self):
        rack = N(name="Rack", chains=[], can_have_chains=True, parameters=[])
        fingerprint = handler_for(rack)["/live/mixingpal/get/rack/fingerprint"]
        empty = fingerprint((0, "0"))
        rack.can_have_chains = False
        self.assertNotEqual(empty, fingerprint((0, "0")))
        for args in [(0,), (0, "0", 3), (-1, "0"), (0, "99"), (0, "bad")]:
            self.assertIsNone(fingerprint(args))
