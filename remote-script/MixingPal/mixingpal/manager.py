from ..manager import Manager
from .master import MasterHandler, ReturnHandler
from .mixer import MixerHandler
from .device_range import DeviceRangeHandler
from .view import ViewOverrideHandler
from .version import VersionHandler


class MixingPalManager(Manager):
    """Extends upstream's handler list without editing vendored code.
    clear_api() walks self.handlers, so appending here keeps teardown correct."""

    def init_api(self):
        super().init_api()
        with self.component_guard():
            self.handlers += [
                MasterHandler(self),
                ReturnHandler(self),
                MixerHandler(self),
                DeviceRangeHandler(self),
                # Registered after upstream's ViewHandler, so this handler's
                # None-safe get_selected_device wins the address.
                ViewOverrideHandler(self),
                VersionHandler(self),
            ]
