"""The connector writes to a set in exactly one place.

The 2026-09-07 set identity spec carved one exception out of "no writes to
the set": the identity key, written by set_identity.py. Nothing else under
mixingpal/ may call Song.set_data, and no handler may register a /set/
address of its own. The app's own guard (src-tauri/src/osc/socket.rs) cannot
see a write that happens inside the connector on a /get/ poll, so this
source-level tripwire is what pins the invariant on this side of the wire.

Run: python3 -m unittest discover -s remote-script/tests -v
"""

import os
import re
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_PACKAGE = os.path.join(_HERE, "..", "MixingPal", "mixingpal")


def _sources():
    for name in sorted(os.listdir(_PACKAGE)):
        if name.endswith(".py"):
            with open(os.path.join(_PACKAGE, name)) as f:
                yield name, f.read()


class SingleWriteTests(unittest.TestCase):
    def test_set_data_is_called_only_by_the_identity_handler(self):
        calls = {
            name: len(re.findall(r"\.set_data\(", source))
            for name, source in _sources()
        }
        self.assertEqual(
            {name: n for name, n in calls.items() if n},
            {"set_identity.py": 1},
            "a second Song.set_data call site needs a spec of its own; see "
            "docs/superpowers/specs/2026-09-07-set-identity-design.md",
        )

    def test_no_mixingpal_handler_registers_a_set_address(self):
        for name, source in _sources():
            self.assertNotRegex(
                source,
                r'add_handler\(\s*"/live/[^"]*/set/',
                "%s registers a /set/ address; the connector answers reads only" % name,
            )


if __name__ == "__main__":
    unittest.main()
