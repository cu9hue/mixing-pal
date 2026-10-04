import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as N
import unittest
from unittest.mock import patch


class Base:
    def _start_listen(self, *args, **kwargs):
        pass


def handlers(song):
    root = Path(__file__).resolve().parents[1] / "MixingPal" / "mixingpal"
    base = ModuleType("view_test.abletonosc.handler")
    base.AbletonOSCHandler = Base
    with patch.dict(sys.modules, {base.__name__: base}):
        qualified = "view_test.mixingpal.view"
        spec = importlib.util.spec_from_file_location(qualified, root / "view.py")
        module = importlib.util.module_from_spec(spec)
        sys.modules[qualified] = module
        spec.loader.exec_module(module)
    handler = object.__new__(module.ViewOverrideHandler)
    handler.song = song
    callbacks = {}
    handler.osc_server = N(add_handler=callbacks.__setitem__)
    handler.init_api()
    return callbacks


class SelectedDeviceTests(unittest.TestCase):
    def setUp(self):
        self.eq, self.rack, self.inner = N(name="EQ"), N(name="Rack"), N(name="Inside the rack")
        self.track = N(devices=[self.eq, self.rack], view=N(selected_device=self.eq))
        self.song = N(tracks=[N(), self.track], view=N(selected_track=self.track))
        self.callback = handlers(self.song)["/live/view/get/selected_device"]

    def test_a_top_level_device_reports_its_index(self):
        self.assertEqual(self.callback(()), (1, 0))

    # Raising here sends no reply, so the app would keep naming the previous
    # device as selected.
    def test_a_device_inside_a_rack_reports_no_top_level_device(self):
        self.track.view.selected_device = self.inner
        self.assertEqual(self.callback(()), (1, -1))

    def test_no_selected_device_reports_none(self):
        self.track.view.selected_device = None
        self.assertEqual(self.callback(()), (1, -1))


if __name__ == "__main__":
    unittest.main()
