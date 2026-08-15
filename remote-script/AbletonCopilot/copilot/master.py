from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class MasterHandler(AbletonOSCHandler):
    """Exposes song.master_track, which upstream cannot reach because every
    /live/track/* endpoint resolves through song.tracks (which excludes it)."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "master"

    def init_api(self):
        def mixer_get(prop):
            def handler(params: Tuple[Any] = ()):
                track = self.song.master_track
                return (getattr(track.mixer_device, prop).value,)
            return handler

        def name_get(params: Tuple[Any] = ()):
            return (self.song.master_track.name,)

        def meter_get(params: Tuple[Any] = ()):
            return (self.song.master_track.output_meter_level,)

        for prop in ("volume", "panning"):
            self.osc_server.add_handler(
                "/live/master/get/%s" % prop, mixer_get(prop))

        self.osc_server.add_handler("/live/master/get/name", name_get)
        self.osc_server.add_handler(
            "/live/master/get/output_meter_level", meter_get)


class ReturnHandler(AbletonOSCHandler):
    """Same gap for song.return_tracks."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "return"

    def init_api(self):
        def mixer_get(prop):
            def handler(params: Tuple[Any]):
                index = int(params[0])
                track = self.song.return_tracks[index]
                return (index, getattr(track.mixer_device, prop).value)
            return handler

        def name_get(params: Tuple[Any]):
            index = int(params[0])
            return (index, self.song.return_tracks[index].name)

        def count_get(params: Tuple[Any] = ()):
            return (len(self.song.return_tracks),)

        for prop in ("volume", "panning"):
            self.osc_server.add_handler(
                "/live/return/get/%s" % prop, mixer_get(prop))

        self.osc_server.add_handler("/live/return/get/name", name_get)
        self.osc_server.add_handler("/live/return/get/num_returns", count_get)
