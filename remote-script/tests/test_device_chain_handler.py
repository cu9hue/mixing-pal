import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as N
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "MixingPal"))
from pythonosc.osc_message_builder import OscMessageBuilder


def handler_for(devices):
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("device_test.abletonosc.handler")
    base.AbletonOSCHandler = object
    with patch.dict(sys.modules, {base.__name__: base}):
        for name in ("rack_paths", "device_range"):
            qualified = "device_test.mixingpal." + name
            spec = importlib.util.spec_from_file_location(qualified, root / (name + ".py"))
            module = importlib.util.module_from_spec(spec)
            sys.modules[qualified] = module
            spec.loader.exec_module(module)
    handler = object.__new__(module.DeviceRangeHandler)
    handler.song = N(tracks=[N(devices=devices)])
    callbacks = {}
    handler.osc_server = N(add_handler=callbacks.__setitem__)
    handler.init_api()
    return callbacks


class DeviceChainHandlerTests(unittest.TestCase):
    def test_long_unicode_chain_pages_fit_udp_and_preserve_indices_and_flags(self):
        address = "/live/mixingpal/get/device_chain"
        devices = [N(name=str(i) + "😀" * 200, can_have_chains=i % 2 == 0) for i in range(100)]
        callbacks = handler_for(devices)
        self.assertIn(address, callbacks)
        callback = callbacks[address]
        offset = 0
        while offset < len(devices):
            reply = callback((0, offset, 256))
            self.assertEqual(reply[:3], (0, offset, 100))
            builder = OscMessageBuilder(address=address)
            for value in reply:
                builder.add_arg(value)
            self.assertLessEqual(len(builder.build().dgram), 9216)
            count = (len(reply) - 3) // 2
            self.assertGreater(count, 0)
            for index in range(count):
                self.assertEqual(reply[3 + index * 2], devices[offset + index].name[:200])
                self.assertEqual(reply[4 + index * 2], devices[offset + index].can_have_chains)
            offset += count
        self.assertEqual(callback((0, 100, 256)), (0, 100, 100))

    def test_digest_covers_order_names_and_rack_flags_outside_the_page(self):
        devices = [N(name=str(i), can_have_chains=False) for i in range(5)]
        callback = handler_for(devices)["/live/mixingpal/get/device_chain/fingerprint"]
        first = callback((0,))
        devices[3], devices[4] = devices[4], devices[3]
        reordered = callback((0,))
        self.assertNotEqual(first[2], reordered[2])
        devices[4].name = "renamed"
        renamed = callback((0,))
        self.assertNotEqual(reordered[2], renamed[2])
        devices[4].can_have_chains = True
        self.assertNotEqual(renamed[2], callback((0,))[2])

    def test_fingerprint_validates_scope_and_empty_track(self):
        callback = handler_for([])["/live/mixingpal/get/device_chain/fingerprint"]
        empty = callback((0,))
        self.assertEqual(empty[:2], (0, 0))
        self.assertRegex(empty[2], r"^[0-9a-f]{64}$")
        self.assertEqual(empty, callback((0,)))
        for args in [(), (0, 1), (-1,), (1,), ("bad",)]:
            self.assertIsNone(callback(args))

    def test_unreadable_device_metadata_has_no_fingerprint(self):
        callback = handler_for([N(name="missing rack flag")])[
            "/live/mixingpal/get/device_chain/fingerprint"]
        self.assertIsNone(callback((0,)))

    def test_empty_track_is_a_real_empty_page_and_invalid_scope_is_rejected(self):
        callbacks = handler_for([])
        address = "/live/mixingpal/get/device_chain"
        self.assertIn(address, callbacks)
        callback = callbacks[address]
        self.assertEqual(callback((0, 0, 256)), (0, 0, 0))
        for args in [(0, -1, 1), (0, 0, -1), (-1, 0, 1), (1, 0, 1)]:
            self.assertIsNone(callback(args))
