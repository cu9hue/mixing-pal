import uuid
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .set_identity_rules import KEY, UNREAD, decide, valid_id


class SetIdentityHandler(AbletonOSCHandler):
    """Answers /live/mixingpal/get/set_identity with (stored_set_id, name,
    file_path), empty strings meaning none.

    The one write this connector ever makes to a set: the identity key,
    under the conditions in docs/superpowers/specs/2026-09-07-set-identity-
    design.md. The decision lives in set_identity_rules.py; this class holds
    the previous read, the try/excepts, and the read-back. Each of the three
    reads is guarded on its own, so one property raising never takes the
    other two down with it. Logs on change and on write only: the log
    rotates at 2 MB, and a line per poll would turn the spike's own evidence
    over in a day.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "mixingpal"
        # After super().__init__: init_api runs inside it, but the callback
        # it registers is only called once Live starts sending, by which
        # time these exist.
        self._previous = UNREAD
        self._last_logged = None

    def init_api(self):
        def set_identity(params: Tuple[Any] = ()):
            reply = (
                self._stored_id(),
                self._read("name", lambda: self.song.name),
                self._read("file_path", lambda: self.song.file_path),
            )
            if reply != self._last_logged:
                self.logger.info(
                    "MixingPal set identity: id=%r name=%r path=%r" % reply)
                self._last_logged = reply
            return reply

        self.osc_server.add_handler(
            "/live/mixingpal/get/set_identity", set_identity)

    def _read(self, what, read):
        try:
            value = read()
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: reading %s raised %r" % (what, e))
            return ""
        return value if isinstance(value, str) else ""

    def _stored_id(self):
        try:
            current = self.song.get_data(KEY, None)
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: get_data raised %r" % (e,))
            self._previous = UNREAD
            return ""
        report, write = decide(
            self._previous, current, lambda: uuid.uuid4().hex)
        self._previous = current
        if write is None:
            return report
        try:
            self.song.set_data(KEY, write)
            read_back = self.song.get_data(KEY, None)
        except Exception as e:
            self.logger.error(
                "MixingPal set identity: writing the key raised %r" % (e,))
            return ""
        self.logger.info(
            "MixingPal set identity: wrote %r, read back %r"
            % (write, read_back))
        self._previous = read_back
        return valid_id(read_back)
