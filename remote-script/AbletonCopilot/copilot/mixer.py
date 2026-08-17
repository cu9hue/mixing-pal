from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


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

        self.osc_server.add_handler(
            "/live/track/get/volume_db", track_volume_db)
        self.osc_server.add_handler(
            "/live/master/get/volume_db", master_volume_db)
        self.osc_server.add_handler(
            "/live/track/get/mixer_data", mixer_data)
