from ..manager import Manager
from .master import MasterHandler, ReturnHandler


class CopilotManager(Manager):
    """Extends upstream's handler list without editing vendored code.
    clear_api() walks self.handlers, so appending here keeps teardown correct."""

    def init_api(self):
        super().init_api()
        with self.component_guard():
            self.handlers += [
                MasterHandler(self),
                ReturnHandler(self),
            ]
