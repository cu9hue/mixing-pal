from functools import partial
from typing import Optional, Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class ViewOverrideHandler(AbletonOSCHandler):
    """Upstream's view.py does list(...).index(...) in three places --
    get_selected_device, get_selected_track (and get_selected_clip, which
    calls it), and the selected_track start_listen getter -- all raising
    'ValueError: <X> is not in list' whenever the selected object is not in
    the collection being indexed.

    For devices, that's whenever no device is selected on the selected
    track (the normal state, not an edge case). For tracks, that's whenever
    Master or a Return track is selected: song.tracks excludes both -- that
    exclusion is the entire reason this fork exists -- so selecting Master
    (routine: you go there to check the limiter) raises. Confirmed against
    real Live.

    Beyond throwing on that one request, an uncaught ValueError here is
    worse than it looks: osc_server.py's process() catches it at a level
    that breaks out of the recvfrom drain loop for that tick, so any other
    datagrams already queued behind it go unprocessed until the next tick.
    And because upstream binds the start_listen getter eagerly via
    functools.partial, the same crash fires from inside Live's own
    property_changed_callback the moment the user clicks Master in the UI,
    with no query involved at all.

    Registers over the same addresses (osc_server.add_handler keys on the
    literal string and the manager appends our handlers after upstream's,
    so the last registration for an address wins -- see MixingPalManager)
    with versions that report track index -1 instead of crashing when the
    selected track is Master or a Return track."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "view"

    def _track_index(self):
        try:
            return list(self.song.tracks).index(self.song.view.selected_track)
        except ValueError:
            return -1  # master or a return track is selected

    def init_api(self):
        def get_selected_track(params: Optional[Tuple] = ()):
            return (self._track_index(),)

        def get_selected_device(params: Optional[Tuple] = ()):
            track_index = self._track_index()
            track = self.song.view.selected_track
            device = track.view.selected_device
            if device is None:
                return (track_index, -1)
            device_index = list(track.devices).index(device)
            return (track_index, device_index)

        def get_selected_clip(params: Optional[Tuple] = ()):
            scene_index = list(self.song.scenes).index(self.song.view.selected_scene)
            return (self._track_index(), scene_index)

        self.osc_server.add_handler(
            "/live/view/get/selected_track", get_selected_track)
        self.osc_server.add_handler(
            "/live/view/get/selected_device", get_selected_device)
        self.osc_server.add_handler(
            "/live/view/get/selected_clip", get_selected_clip)

        # Upstream binds this listener's getter eagerly via partial (see
        # abletonosc/view.py), so the None-safe get_selected_track above
        # never gets called for it -- the listener callback still holds
        # upstream's unsafe getter unless we also override the
        # start_listen registration itself.
        self.osc_server.add_handler(
            "/live/view/start_listen/selected_track",
            partial(self._start_listen, self.song.view, "selected_track",
                    getter=get_selected_track))
