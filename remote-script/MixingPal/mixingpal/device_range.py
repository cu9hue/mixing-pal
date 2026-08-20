from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class DeviceRangeHandler(AbletonOSCHandler):
    """Upstream returns every parameter in one datagram. An Instrument Rack can
    exceed 1000 parameters, which blows past the 9216-byte macOS UDP cap and
    makes sendto raise, so the client receives nothing at all. This mirrors the
    ranged form that clip note queries already have."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "device_range"

    def init_api(self):
        def params_for(track_index, device_index):
            return self.song.tracks[track_index].devices[device_index].parameters

        def window_for(track_index, device_index, start, span):
            # Clamp before slicing: Python treats a negative stop as "from
            # the end," not "empty," so a negative span (or start) would
            # otherwise return far more than the caller asked for and blow
            # past the datagram cap this ranged form exists to avoid.
            start = max(0, start)
            span = max(0, span)
            all_params = params_for(track_index, device_index)
            return start, list(all_params)[start:start + span]

        def value_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            start, window = window_for(track_index, device_index, start, span)
            values = [p.value for p in window]
            return (track_index, device_index, start, *values)

        def name_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            start, window = window_for(track_index, device_index, start, span)
            names = [p.name for p in window]
            return (track_index, device_index, start, *names)

        def value_string_range(params: Tuple[Any]):
            track_index, device_index = int(params[0]), int(params[1])
            start, span = int(params[2]), int(params[3])
            start, window = window_for(track_index, device_index, start, span)
            strings = [p.str_for_value(p.value) for p in window]
            return (track_index, device_index, start, *strings)

        self.osc_server.add_handler(
            "/live/device/get/parameters/value_range", value_range)
        self.osc_server.add_handler(
            "/live/device/get/parameters/name_range", name_range)
        self.osc_server.add_handler(
            "/live/device/get/parameters/value_string_range", value_string_range)
