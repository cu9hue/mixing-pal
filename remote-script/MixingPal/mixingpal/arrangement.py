from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .arrangement_replies import arrangement_reply, clips_of, window_of


class ArrangementHandler(AbletonOSCHandler):
    """Reads the arrangement.

    Upstream exposes a track's arrangement clips as three separate list
    endpoints (names, start times, lengths). Three endpoints are three
    moments: a producer editing between the replies leaves the client zipping
    a name to another clip's position, and when the lists happen to stay the
    same length nothing detects it. This endpoint answers all three fields
    for a clip in one reply, so they cannot disagree.

    Ranged for the reason `rack.py` is: a track with many clips serialises
    past the datagram cap, and only the sender knows the sizes.

    Returning None sends no reply at all (see `osc_server.process_message`'s
    `if rv is not None`), which is byte-identical to a lost datagram from the
    client's side. That is how "there is no track at that index" arrives.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "arrangement"

    def init_api(self):
        def track_at(index):
            tracks = self.song.tracks
            if index < 0 or index >= len(tracks):
                return None
            return tracks[index]

        def arrangement(params: Tuple[Any]):
            track_index = int(params[0])
            track = track_at(track_index)
            if track is None:
                return None
            start, span = max(0, int(params[1])), max(0, int(params[2]))
            entries = clips_of(track)
            records = window_of(entries, start, span)
            return arrangement_reply(track_index, start, len(entries), records)

        self.osc_server.add_handler(
            "/live/mixingpal/get/arrangement", arrangement)
