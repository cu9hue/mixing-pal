from typing import Optional, Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler


class ViewOverrideHandler(AbletonOSCHandler):
    """Upstream's view.py get_selected_device does
    list(...devices).index(...selected_device), which raises
    'ValueError: None is not in list' whenever no device is selected on the
    selected track -- the normal state, not an edge case. Confirmed against
    real Live: 7 failures in seconds of polling, one per poll tick, flooding
    the log and leaving the request unanswered every time.

    Registers over the same address (osc_server.add_handler keys on the
    literal string and the manager appends our handlers after upstream's,
    so the last registration for an address wins -- see CopilotManager)
    with a None-safe version that reports device index -1 instead of
    crashing the query."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "view"

    def init_api(self):
        def get_selected_device(params: Optional[Tuple] = ()):
            track = self.song.view.selected_track
            track_index = list(self.song.tracks).index(track)
            device = track.view.selected_device
            if device is None:
                return (track_index, -1)
            device_index = list(track.devices).index(device)
            return (track_index, device_index)

        self.osc_server.add_handler(
            "/live/view/get/selected_device", get_selected_device)
