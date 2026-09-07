from ..manager import Manager
from .master import MasterHandler, ReturnHandler
from .mixer import MixerHandler
from .clip_notes import ClipNotesHandler
from .arrangement import ArrangementHandler
from .device_range import DeviceRangeHandler
from .rack import RackHandler
from .view import ViewOverrideHandler
from .version import VersionHandler
from .set_identity import SetIdentityHandler


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
                ClipNotesHandler(self),
                ArrangementHandler(self),
                DeviceRangeHandler(self),
                RackHandler(self),
                # Registered after upstream's ViewHandler, so this handler's
                # None-safe get_selected_device wins the address.
                ViewOverrideHandler(self),
                VersionHandler(self),
                SetIdentityHandler(self),
            ]
