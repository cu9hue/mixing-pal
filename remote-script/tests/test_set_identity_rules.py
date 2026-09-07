"""Unit tests for mixingpal/set_identity_rules.py.

The module is loaded by file path rather than imported as
`mixingpal.set_identity_rules`, for the same reason `test_rack_paths.py`
does it: `mixingpal/__init__.py` imports every handler, and those reach
`ableton.v2.control_surface`, which exists only inside Live.

What these pin is the one write this connector ever makes to a set. Spec:
docs/superpowers/specs/2026-09-07-set-identity-design.md, "The value rule"
and "The write decision".

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_TARGET = os.path.join(_HERE, "..", "MixingPal", "mixingpal", "set_identity_rules.py")
_SPEC = importlib.util.spec_from_file_location("set_identity_rules", _TARGET)
rules = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(rules)

VALID = "0123456789abcdef0123456789abcdef"


class ValidIdTests(unittest.TestCase):
    def test_a_dict_with_a_32_hex_set_id_is_that_id(self):
        self.assertEqual(rules.valid_id({"set_id": VALID}), VALID)

    def test_extra_keys_beside_set_id_do_not_invalidate_it(self):
        # A later version adds a field by adding a key and keeping set_id.
        self.assertEqual(rules.valid_id({"set_id": VALID, "note": "x"}), VALID)

    def test_none_is_no_id(self):
        self.assertEqual(rules.valid_id(None), "")

    def test_a_non_dict_is_no_id(self):
        self.assertEqual(rules.valid_id("abc"), "")
        self.assertEqual(rules.valid_id(["set_id", VALID]), "")

    def test_a_dict_without_set_id_is_no_id(self):
        self.assertEqual(rules.valid_id({}), "")
        self.assertEqual(rules.valid_id({"id": VALID}), "")

    def test_a_set_id_that_is_not_32_lowercase_hex_is_no_id(self):
        self.assertEqual(rules.valid_id({"set_id": VALID.upper()}), "")
        self.assertEqual(rules.valid_id({"set_id": VALID[:-1]}), "")
        self.assertEqual(rules.valid_id({"set_id": 42}), "")


class DecideTests(unittest.TestCase):
    def setUp(self):
        self.calls = 0

        def generate():
            self.calls += 1
            return VALID

        self.generate = generate

    def test_a_valid_id_is_reported_and_nothing_is_written(self):
        report, write = rules.decide(None, {"set_id": VALID}, self.generate)
        self.assertEqual(report, VALID)
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_two_absent_reads_in_a_row_write_a_new_id(self):
        report, write = rules.decide(None, None, self.generate)
        self.assertEqual(report, "")
        self.assertEqual(write, {"set_id": VALID})
        self.assertEqual(self.calls, 1)

    def test_the_first_poll_never_writes(self):
        # No previous read yet: a transient default during a document load
        # is read once and left alone.
        report, write = rules.decide(rules.UNREAD, None, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_a_value_with_no_valid_id_is_never_written_over(self):
        foreign = {"other": 1}
        report, write = rules.decide(foreign, foreign, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        bad = {"set_id": "nope"}
        report, write = rules.decide(bad, bad, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)

    def test_an_absent_read_after_a_foreign_one_does_not_write_yet(self):
        report, write = rules.decide({"other": 1}, None, self.generate)
        self.assertEqual(report, "")
        self.assertIsNone(write)
        self.assertEqual(self.calls, 0)


if __name__ == "__main__":
    unittest.main()
