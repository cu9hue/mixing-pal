from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .device_range import chain_reply
from .rack_paths import NAME_CAP

_UNREADABLE = (TypeError, ValueError, OverflowError, AttributeError, RuntimeError, IndexError)


def _shown(param):
    """The value as Live shows it, and its automation state (0 none, 1 automated, 2 overridden)."""
    return (param.str_for_value(param.value), int(param.automation_state))


class MixerHandler(AbletonOSCHandler):
    """track_data cannot fetch faders because song.py does getattr(track, prop)
    and volume/panning live on track.mixer_device. Also exposes the formatted
    dB string, which the LOM has on the volume DeviceParameter but upstream
    never surfaces."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "mixer"

    def init_api(self):
        def track_volume_db(params: Tuple[Any]):
            index = int(params[0])
            param = self.song.tracks[index].mixer_device.volume
            return (index, param.str_for_value(param.value))

        def master_volume_db(params: Tuple[Any] = ()):
            param = self.song.master_track.mixer_device.volume
            return (param.str_for_value(param.value),)

        def mixer_data(params: Tuple[Any]):
            index_min, index_max = int(params[0]), int(params[1])
            if index_max == -1:
                index_max = len(self.song.tracks)
            rv = []
            for i in range(index_min, index_max):
                mixer = self.song.tracks[i].mixer_device
                rv.append(mixer.volume.value)
                rv.append(mixer.panning.value)
                # The formatted dB string. In the LOM, mixer_device.volume is
                # a DeviceParameter, so str_for_value is the same conversion
                # Live shows on the fader -- upstream never surfaces it, and
                # a normalised 0..1 value alone tells a reader nothing about
                # gain structure.
                rv.append(mixer.volume.str_for_value(mixer.volume.value))
            return tuple(rv)

        def track_mixer(params: Tuple[Any]):
            """(track, volume, state, pan, state, output, group_track, n_sends, *(send, state)).

            group_track is the index of the Group the track sits in, or -1.
            """
            if len(params) != 1:
                return None
            try:
                index = int(params[0])
                tracks = self.song.tracks
                if index < 0 or index >= len(tracks):
                    return None
                track = tracks[index]
                mixer = track.mixer_device
                # get_mixer asks for every track in one tick, so only a grouped
                # track pays for walking the track list.
                group = list(tracks).index(track.group_track) if track.is_grouped else -1
                reply = [index, *_shown(mixer.volume), *_shown(mixer.panning),
                         str(track.output_routing_type.display_name)[:NAME_CAP], group, len(mixer.sends)]
                for send in mixer.sends:
                    reply.extend(_shown(send))
            except _UNREADABLE:
                return None
            return tuple(reply)

        def return_mixer(params: Tuple[Any]):
            """(index, n_returns, name, volume, state, pan, state, n_devices, *device records)."""
            if len(params) != 1:
                return None
            try:
                index = int(params[0])
                returns = self.song.return_tracks
                if index < 0 or index >= len(returns):
                    return None
                track = returns[index]
                mixer = track.mixer_device
                return chain_reply((index, len(returns), str(track.name)[:NAME_CAP],
                                    *_shown(mixer.volume), *_shown(mixer.panning)), track.devices)
            except _UNREADABLE:
                return None

        def master_mixer(params: Tuple[Any] = ()):
            """(name, volume, state, pan, state, n_devices, *device records)."""
            try:
                track = self.song.master_track
                mixer = track.mixer_device
                return chain_reply((str(track.name)[:NAME_CAP], *_shown(mixer.volume),
                                    *_shown(mixer.panning)), track.devices)
            except _UNREADABLE:
                return None

        self.osc_server.add_handler("/live/mixingpal/get/track_mixer", track_mixer)
        self.osc_server.add_handler("/live/mixingpal/get/return_mixer", return_mixer)
        self.osc_server.add_handler("/live/mixingpal/get/master_mixer", master_mixer)
        self.osc_server.add_handler(
            "/live/track/get/volume_db", track_volume_db)
        self.osc_server.add_handler(
            "/live/master/get/volume_db", master_volume_db)
        self.osc_server.add_handler(
            "/live/track/get/mixer_data", mixer_data)
