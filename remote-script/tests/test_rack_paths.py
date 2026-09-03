"""Unit tests for mixingpal/rack_paths.py.

The module is loaded by file path rather than imported as `mixingpal.rack_paths`
because `mixingpal/__init__.py` imports every handler, and those reach
`ableton.v2.control_surface`, which exists only inside Live. Loading the one
file directly is what keeps this logic testable at all.

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import importlib.util
import os
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "rack_paths.py")
_SPEC = importlib.util.spec_from_file_location("rack_paths", _TARGET)
rack_paths = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rack_paths)

# The vendored pythonosc, which is what actually serialises a reply inside
# Live. Used below to measure what a record really costs instead of
# recomputing it, so the test cannot repeat the estimator's own mistake.
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


class FakeDevice(object):
    def __init__(self, name, chains=None, drum_pads=None, parameters=()):
        self.name = name
        self.parameters = list(parameters)
        if chains is not None:
            self.chains = chains
            self.can_have_chains = True
        if drum_pads is not None:
            self.drum_pads = drum_pads
            self.can_have_drum_pads = True
            # A Drum Rack reports both flags. chains_of must not read this
            # one when drum_pads is present, or the pad note is lost.
            self.chains = [p.chains[0] for p in drum_pads if p.chains]


class FakeChain(object):
    def __init__(self, name, devices=(), mute=False, solo=False):
        self.name = name
        self.devices = list(devices)
        self.mute = mute
        self.solo = solo


class FakePad(object):
    def __init__(self, note, name, chains=(), mute=False, solo=False):
        self.note = note
        self.name = name
        self.chains = list(chains)
        self.mute = mute
        self.solo = solo


class FakeTrack(object):
    def __init__(self, devices):
        self.devices = list(devices)


class ParsePathTests(unittest.TestCase):
    def test_odd_lengths_parse_and_even_lengths_do_not(self):
        self.assertEqual(rack_paths.parse_path("0"), [0])
        self.assertEqual(rack_paths.parse_path("0.4.1"), [0, 4, 1])
        self.assertIsNone(rack_paths.parse_path("0.4"))

    def test_junk_is_refused_rather_than_coerced(self):
        # int("-1") would succeed and then slice from the END of the list,
        # resolving to a real but different device.
        for raw in ["", "-1", "0.-1.0", "1x", "+1", " 1", "a", "0..1", "0.4.1.0.1.0.1.0.1.0.1"]:
            self.assertIsNone(rack_paths.parse_path(raw), raw)

    def test_non_ascii_digits_are_refused(self):
        # str.isdigit() is true for U+0663 and int() parses it, so the naive
        # check would accept a path this app never generated.
        self.assertIsNone(rack_paths.parse_path("٣"))

    def test_a_component_longer_than_ten_digits_is_refused(self):
        # A component of 4000 digits puts ~4 KB into the OSC header (the path
        # is echoed in the reply), so the datagram lands around 13 KB and
        # Live's sendto raises, leaving the client in silence.
        self.assertIsNone(rack_paths.parse_path("0." + "0"*4000 + ".0"))

    def test_values_above_i32_max_are_refused(self):
        # The Rust side refuses anything above i32::MAX, so the two ends
        # currently disagree if we accept it here.
        self.assertIsNone(rack_paths.parse_path(str(2**31)))
        self.assertEqual(rack_paths.parse_path(str(2**31 - 1)), [2147483647])


class ChainsOfTests(unittest.TestCase):
    def test_a_plain_device_has_no_chains_and_does_not_raise(self):
        self.assertEqual(rack_paths.chains_of(FakeDevice("EQ Eight")), [])

    def test_an_audio_effect_rack_lists_its_chains_with_no_note(self):
        rack = FakeDevice("Rack", chains=[FakeChain("Dry"), FakeChain("Wet", solo=True)])
        got = rack_paths.chains_of(rack)
        self.assertEqual([(n, name, m, s) for (_, n, name, m, s, _) in got],
                         [(-1, "Dry", False, False), (-1, "Wet", False, True)])

    def test_a_drum_rack_enumerates_pads_so_the_note_travels_with_its_own_chain(self):
        # This is the whole point of the function. Listing from drum_pads and
        # resolving through chains would pair the two by position, which
        # assumes an ordering the LOM does not promise -- and when it is
        # wrong, every pad carries its neighbour's note inside an answer that
        # looks complete.
        kick = FakeChain("Kick", devices=[FakeDevice("Simpler")])
        hats = FakeChain("Hats", devices=[FakeDevice("Simpler")])
        rack = FakeDevice("Drum Rack", drum_pads=[
            FakePad(36, "Kick", [kick]),
            FakePad(37, "empty", []),
            FakePad(42, "Hats", [hats], mute=True),
        ])
        got = rack_paths.chains_of(rack)
        self.assertEqual([(c, n, name, m) for (c, n, name, m, _, _) in got],
                         [(kick, 36, "Kick", False), (hats, 42, "Hats", True)])

    def test_a_kit_of_entirely_empty_pads_lists_nothing(self):
        rack = FakeDevice("Drum Rack", drum_pads=[FakePad(i, str(i), []) for i in range(128)])
        self.assertEqual(rack_paths.chains_of(rack), [])


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self.leaf = FakeDevice("Saturator")
        self.inner = FakeDevice("Inner Rack", chains=[FakeChain("A", [self.leaf])])
        self.pad_chain = FakeChain("Kick", devices=[FakeDevice("Simpler"), self.inner])
        self.drum = FakeDevice("Drum Rack", drum_pads=[
            FakePad(35, "empty", []),
            FakePad(36, "Kick", [self.pad_chain]),
        ])
        self.track = FakeTrack([self.drum, FakeDevice("Glue Compressor")])

    def test_a_single_element_path_is_a_top_level_device(self):
        self.assertEqual(rack_paths.resolve(self.track, [1]).name, "Glue Compressor")

    def test_resolution_indexes_the_same_list_the_listing_reported(self):
        # The empty pad at 35 is not chain 0. If listing and resolution used
        # different enumerations, this would return the wrong device.
        self.assertEqual(rack_paths.resolve(self.track, [0, 0, 0]).name, "Simpler")

    def test_it_walks_a_rack_inside_a_drum_pad(self):
        self.assertIs(rack_paths.resolve(self.track, [0, 0, 1, 0, 0]), self.leaf)

    def test_an_index_past_the_end_raises_rather_than_returning_something(self):
        # AbletonOSC turns the raise into no reply at all, byte-identical to
        # a lost datagram -- the documented behaviour of every device address.
        with self.assertRaises(IndexError):
            rack_paths.resolve(self.track, [9])
        with self.assertRaises(IndexError):
            rack_paths.resolve(self.track, [0, 9, 0])


class WindowTests(unittest.TestCase):
    def entries(self, count, devices_each=2, name="Chain"):
        return [
            (FakeChain(name, [FakeDevice("Dev%d" % d) for d in range(devices_each)]),
             -1, "%s%d" % (name, i), False, False, None)
            for i in range(count)
        ]

    def test_a_record_reports_its_true_device_count_and_how_many_it_carries(self):
        entries = self.entries(1, devices_each=40)
        (record,) = rack_paths.build_window(entries, 0, 1)
        # name, note, mute, solo, sample, total_devices, reported_devices,
        # then (name, is_rack) pairs.
        self.assertEqual(record[5], 40)
        self.assertEqual(record[6], rack_paths.MAX_DEVICES_PER_CHAIN)
        self.assertEqual(len(record), 7 + 2 * rack_paths.MAX_DEVICES_PER_CHAIN)

    def test_a_nested_rack_is_marked_in_its_parent_chain_record(self):
        nested = FakeDevice("Combine Kit", chains=[FakeChain("Pads")])
        entry = (FakeChain("Parent", [nested]), -1, "Parent", False, False, None)
        record = rack_paths.chain_record(entry)
        self.assertEqual(record[7:], ("Combine Kit", 1))

    def test_the_estimate_covers_a_multi_byte_chain_record(self):
        # pythonosc encodes a string with `val.encode('utf-8')`, so a chain
        # or device named in emoji or CJK costs up to 4x what its codepoint
        # count says. Under-counting is what packs a window past the cap,
        # and past the cap Live's sendto raises and the client receives
        # nothing at all.
        record = rack_paths.chain_record(
            (FakeChain("\U0001F3B9\U0001F3B9\U0001F3B9",
                       [FakeDevice("コンプレッサー")]),
             -1, "\U0001F3B9\U0001F3B9\U0001F3B9", False, False, None))
        self.assertGreaterEqual(
            rack_paths.record_bytes(record), encoded_arg_bytes(record))

    def test_a_window_of_multi_byte_names_still_fits_a_datagram(self):
        # What the cap actually protects: a whole window, not one record.
        name = "é" * rack_paths.NAME_CAP
        entries = [(FakeChain(name, [FakeDevice(name) for _ in range(4)]),
                    -1, name, False, False, None) for _ in range(64)]
        window = rack_paths.build_window(entries, 0, 64)
        encoded = encoded_arg_bytes([f for r in window for f in r])
        self.assertLessEqual(encoded, rack_paths.MAX_REPLY_BYTES)

    def test_the_span_bounds_the_window(self):
        self.assertEqual(len(rack_paths.build_window(self.entries(50), 0, 8)), 8)

    def test_the_window_starts_where_it_was_asked_to(self):
        (record,) = rack_paths.build_window(self.entries(50), 7, 1)
        self.assertEqual(record[0], "Chain7")

    def test_the_handler_stops_early_rather_than_overfilling_a_datagram(self):
        # 23 chains of 32 devices serialises to roughly 48 KB. Live's sendto
        # raises past MAX_DATAGRAM and the client receives NOTHING -- so the
        # sender, which is the only side that knows the sizes, has to stop.
        fat = self.entries(40, devices_each=32)
        window = rack_paths.build_window(fat, 0, 40)
        self.assertLess(len(window), 40)
        total = sum(rack_paths.record_bytes(r) for r in window)
        self.assertLessEqual(total, rack_paths.MAX_REPLY_BYTES)

    def test_a_single_oversized_chain_is_cut_back_rather_than_dropped(self):
        # Every reply must carry at least one record, or the client's paging
        # loop makes no progress and spins until MAX_WINDOWS.
        huge = [(FakeChain("Wide", [FakeDevice("D" * rack_paths.NAME_CAP)
                                    for _ in range(rack_paths.MAX_DEVICES_PER_CHAIN)]),
                 -1, "Wide", False, False, None)]
        window = rack_paths.build_window(huge, 0, 1, budget=400)
        self.assertEqual(len(window), 1)
        self.assertEqual(window[0][5], rack_paths.MAX_DEVICES_PER_CHAIN)  # truth kept
        self.assertLess(window[0][6], rack_paths.MAX_DEVICES_PER_CHAIN)   # payload cut
        self.assertLessEqual(rack_paths.record_bytes(window[0]), 400)

    def test_names_are_capped_so_a_record_always_fits(self):
        # Bounds the worst case: with the name list emptied, a record is six
        # fixed fields plus a capped name, far inside one datagram.
        long_name = "x" * 5000
        long_device_name = "y" * (rack_paths.NAME_CAP + 100)
        entries = [(FakeChain(long_name, [FakeDevice(long_device_name)]), -1, long_name, False, False, None)]
        (record,) = rack_paths.build_window(entries, 0, 1)
        self.assertEqual(len(record[0]), rack_paths.NAME_CAP)  # chain name capped
        # record[7] is the first (and only) device name in the tuple.
        self.assertEqual(len(record[7]), rack_paths.NAME_CAP)  # device name capped

    def test_a_start_past_the_end_returns_nothing_rather_than_wrapping(self):
        self.assertEqual(rack_paths.build_window(self.entries(3), 10, 8), [])

    def test_a_negative_start_and_span_clamp_to_zero_rather_than_wrapping(self):
        # Unexercised by every other test here: an un-clamped negative span
        # makes the stop bound negative too, and Python reads a negative
        # slice bound as "from the end" rather than as "before the start" --
        # silently returning real records instead of none, the same shape of
        # bug as the sibling task's negative-span slicing defect.
        self.assertEqual(rack_paths.build_window(self.entries(3), -1, -1), [])


if __name__ == "__main__":
    unittest.main()
