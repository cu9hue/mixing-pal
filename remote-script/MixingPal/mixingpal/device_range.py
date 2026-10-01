import hashlib
import json

from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .rack_paths import parse_path, resolve, NAME_CAP, MAX_REPLY_BYTES, osc_string_bytes


class DeviceRangeHandler(AbletonOSCHandler):
    """Upstream returns every parameter in one datagram. An Instrument Rack can
    exceed 1000 parameters, which blows past the 9216-byte macOS UDP cap and
    makes sendto raise, so the client receives nothing at all. This mirrors the
    ranged form that clip note queries already have.

    Since wire version 3 the device is named by a dotted path rather than a
    top-level index, so these addresses reach inside Racks. The reply echoes
    the path string in the position the device index used to occupy, which
    leaves the keying at KeyArity::Args(3) -- see src-tauri/src/osc/arity.rs.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "device_range"

    def init_api(self):
        def device_chain_fingerprint(params):
            if len(params) != 1:
                return None
            try:
                track = int(params[0])
                if track < 0 or track >= len(self.song.tracks):
                    return None
                records = tuple((str(device.name)[:NAME_CAP], bool(device.can_have_chains))
                                for device in self.song.tracks[track].devices)
            except (TypeError, ValueError, OverflowError, AttributeError, RuntimeError):
                return None
            digest = hashlib.sha256(json.dumps(records, separators=(",", ":")).encode("utf-8"))
            return (track, len(records), digest.hexdigest())

        self.osc_server.add_handler(
            "/live/mixingpal/get/device_chain/fingerprint", device_chain_fingerprint)

        def device_chain(params):
            if len(params) != 3:
                return None
            try:
                track, start, span = (int(value) for value in params)
            except (TypeError, ValueError, OverflowError):
                return None
            if track < 0 or track >= len(self.song.tracks) or start < 0 or span <= 0:
                return None
            devices = self.song.tracks[track].devices
            reply = [track, start, len(devices)]
            used = 0
            for device in devices[start:start + min(span, 256)]:
                name = str(device.name)[:NAME_CAP]
                size = osc_string_bytes(name) + 6
                if used + size > MAX_REPLY_BYTES:
                    break
                reply.extend((name, bool(device.can_have_chains)))
                used += size
            return tuple(reply)

        self.osc_server.add_handler("/live/mixingpal/get/device_chain", device_chain)

        def window_for(params):
            """(track_index, raw_path, start, window) or None.

            Clamp before slicing: Python treats a negative stop as "from the
            end," not "empty," so a negative span (or start) would otherwise
            return far more than the caller asked for and blow past the
            datagram cap this ranged form exists to avoid.
            """
            if len(params) != 4:
                return None
            try:
                track_index = int(params[0])
                raw_path = str(params[1])
                start, span = max(0, int(params[2])), max(0, int(params[3]))
            except (TypeError, ValueError):
                return None
            tracks = self.song.tracks
            if track_index < 0 or track_index >= len(tracks):
                return None
            path = parse_path(raw_path)
            if path is None:
                return None
            try:
                device = resolve(tracks[track_index], path)
            except (IndexError, AttributeError):
                return None
            if device is None:
                return None
            window = list(device.parameters)[start:start + span]
            return track_index, raw_path, start, window

        def ranged(project):
            def handler(params: Tuple[Any]):
                got = window_for(params)
                if got is None:
                    return None
                track_index, raw_path, start, window = got
                return (track_index, raw_path, start,
                        *[project(p) for p in window])
            return handler

        self.osc_server.add_handler(
            "/live/device/get/parameters/value_range",
            ranged(lambda p: p.value))
        self.osc_server.add_handler(
            "/live/device/get/parameters/name_range",
            ranged(lambda p: p.name))
        self.osc_server.add_handler(
            "/live/device/get/parameters/value_string_range",
            ranged(lambda p: p.str_for_value(p.value)))
