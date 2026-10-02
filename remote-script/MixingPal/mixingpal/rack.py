import hashlib
import json

from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .rack_paths import NAME_CAP, build_window, chain_record, chains_of, parse_path, resolve


class RackHandler(AbletonOSCHandler):
    """Returning None sends no reply, just like a raise inside a handler.
    Both are indistinguishable from a lost datagram to the client."""

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

        def rack_chains(params: Tuple[Any], ranged=False):
            device, raw_path = device_for(params)
            if device is None:
                return None
            if len(params) != (5 if ranged else 4):
                return None
            try:
                track_index = int(params[0])
                start = max(0, int(params[2]))
                device_offset = max(0, int(params[3])) if ranged else 0
                span = max(0, int(params[4 if ranged else 3]))
            except (TypeError, ValueError):
                return None
            entries = chains_of(device)
            records = build_window(entries, start, span, device_offset=device_offset)
            flat = [field for record in records for field in record]
            # can_have_chains rides along so that two different answers stay
            # different: a device with no chains because it is an EQ, and a
            # Rack with nothing loaded in it, both list zero chains, and only
            # the first is a model error. "This rack is empty" is a real
            # observation about a set.
            header = (track_index, raw_path, start)
            if ranged:
                header += (device_offset,)
            return (*header, len(entries),
                    int(bool(getattr(device, "can_have_chains", False))), *flat)

        def rack_fingerprint(params: Tuple[Any]):
            if len(params) != 2:
                return None
            try:
                device, raw_path = device_for(params)
                if device is None:
                    return None
                entries = chains_of(device)
                metadata = (str(device.name)[:NAME_CAP], len(device.parameters),
                            bool(getattr(device, "can_have_chains", False)))
                digest = hashlib.sha256(json.dumps(metadata, separators=(",", ":")).encode("utf-8"))
                for entry in entries:
                    # Cover devices beyond the first output page too.
                    record = chain_record(entry, max_names=len(entry[0].devices))
                    digest.update(json.dumps(record, separators=(",", ":")).encode("utf-8"))
                return (int(params[0]), raw_path, len(entries), digest.hexdigest())
            except (TypeError, ValueError, OverflowError, IndexError, AttributeError, RuntimeError):
                return None

        def device_identity(params: Tuple[Any]):
            device, raw_path = device_for(params)
            if device is None:
                return None
            return (int(params[0]), raw_path,
                    str(device.name)[:NAME_CAP], len(device.parameters))

        self.osc_server.add_handler(
            "/live/mixingpal/get/rack/fingerprint", rack_fingerprint)
        self.osc_server.add_handler(
            "/live/mixingpal/get/rack/chains", rack_chains)
        self.osc_server.add_handler(
            "/live/mixingpal/get/rack/chains_range", lambda params: rack_chains(params, True))
        self.osc_server.add_handler(
            "/live/mixingpal/get/device/identity", device_identity)
