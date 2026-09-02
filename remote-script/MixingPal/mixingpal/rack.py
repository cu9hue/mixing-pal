from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .rack_paths import NAME_CAP, build_window, chains_of, parse_path, resolve


class RackHandler(AbletonOSCHandler):
    """Opens Racks.

    `track.devices` is top-level only, so without this a loaded Drum Rack is
    one device named "Drum Rack" and the compressor on the kick pad does not
    exist as far as the app is concerned. Two addresses: list a rack's
    chains, and identify any device by path.

    Returning None sends no reply at all (see `osc_server.process_message`'s
    `if rv is not None`), which is the same thing a raise inside a handler
    produces. Both are byte-identical to a lost datagram from the client's
    side, and that equivalence is documented rather than worked around.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "rack"

    def init_api(self):
        def device_for(params):
            """(device, raw_path) or (None, raw_path) for a path this script
            refuses to walk."""
            if len(params) < 2:
                return None, None
            try:
                track_index = int(params[0])
                raw_path = str(params[1])
            except (TypeError, ValueError):
                return None, None
            tracks = self.song.tracks
            if track_index < 0 or track_index >= len(tracks):
                return None, raw_path
            path = parse_path(raw_path)
            if path is None:
                return None, raw_path
            try:
                return resolve(tracks[track_index], path), raw_path
            except (IndexError, AttributeError):
                return None, raw_path

        def rack_chains(params: Tuple[Any]):
            device, raw_path = device_for(params)
            if device is None:
                return None
            if len(params) != 4:
                return None
            try:
                track_index = int(params[0])
                start, span = max(0, int(params[2])), max(0, int(params[3]))
            except (TypeError, ValueError):
                return None
            entries = chains_of(device)
            records = build_window(entries, start, span)
            flat = [field for record in records for field in record]
            # can_have_chains rides along so that two different answers stay
            # different: a device with no chains because it is an EQ, and a
            # Rack with nothing loaded in it, both list zero chains, and only
            # the first is a model error. "This rack is empty" is a real
            # observation about a set.
            return (track_index, raw_path, start, len(entries),
                    int(bool(getattr(device, "can_have_chains", False))), *flat)

        def device_identity(params: Tuple[Any]):
            device, raw_path = device_for(params)
            if device is None:
                return None
            return (int(params[0]), raw_path,
                    str(device.name)[:NAME_CAP], len(device.parameters))

        self.osc_server.add_handler(
            "/live/mixingpal/get/rack/chains", rack_chains)
        self.osc_server.add_handler(
            "/live/mixingpal/get/device/identity", device_identity)
