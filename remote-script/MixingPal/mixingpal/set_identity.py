import uuid
from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .set_identity_rules import (
    KEY, INITIAL, after_failed_read, after_read, after_write)


class SetIdentityHandler(AbletonOSCHandler):
    """Answers /live/mixingpal/get/set_identity with (stored_set_id, name,
    file_path), empty strings meaning none.

    The one write this connector ever makes to a set: the identity key,
    under the conditions in the 2026-09-07 set identity design (git history;
    the rule is in docs/ROADMAP.md, "Not doing"). The decision and the state transitions live in
    set_identity_rules.py, where they can be tested outside Live; this class
    holds the try/excepts, the read-back, and the logging. Each of the three
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
        self._state = INITIAL
        self._last_logged = None
        self._last_errors = {}

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

    def _log_failure(self, what, message):
        """Logs a failing read at INFO, and only when the message changes.

        Two reasons for both halves. INFO because AbletonOSC's own
        _get_property logs a property that raises at INFO, and this is the
        same kind of failure; ERROR is louder than that convention and, in
        manager.py, sends the record to the app as /live/error, which the
        app retains and replays on every reload. On change because a
        property that raises does it on every poll: at 1 Hz that is a line a
        second in a log that rotates at 2 MB, the same reason the reply
        itself is logged on change only.
        """
        if self._last_errors.get(what) != message:
            self.logger.info(message)
            self._last_errors[what] = message

    def _read(self, what, read):
        try:
            value = read()
        except Exception as e:
            self._log_failure(
                what,
                "MixingPal set identity: reading %s raised %r" % (what, e))
            return ""
        return value if isinstance(value, str) else ""

    def _stored_id(self):
        try:
            current = self.song.get_data(KEY, None)
        except Exception as e:
            self._log_failure(
                "get_data",
                "MixingPal set identity: get_data raised %r" % (e,))
            self._state = after_failed_read(self._state)
            return ""
        self._state, report, write = after_read(
            self._state, current, lambda: uuid.uuid4().hex)
        if write is None:
            return report
        try:
            self.song.set_data(KEY, write)
            read_back = self.song.get_data(KEY, None)
        except Exception as e:
            # ERROR, unsuppressed: after_read has already latched the write
            # attempt, so this can happen at most once in this handler's
            # lifetime, and a failed write to her set should stand out in
            # the connector log. manager.py also forwards it to the app as
            # /live/error, which the app drops today; the producer sees
            # only "no stored id", so the log is the record.
            self.logger.error(
                "MixingPal set identity: writing the key raised %r" % (e,))
            return ""
        self.logger.info(
            "MixingPal set identity: wrote %r, read back %r"
            % (write, read_back))
        self._state, report = after_write(self._state, read_back)
        return report
