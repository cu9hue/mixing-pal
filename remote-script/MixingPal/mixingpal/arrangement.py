from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .arrangement_replies import arrangement_reply, clips_of, window_of
from .clip_replies import notes_window_reply, num_notes_reply


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

        def arrangement_clip_at(params):
            """The arrangement clip at (track, index), or None.

            None sends no reply, which is how "there is no clip there"
            reaches the client -- the same way an empty session slot does.
            """
            track = track_at(int(params[0]))
            if track is None:
                return None
            clips = track.arrangement_clips
            index = int(params[1])
            if index < 0 or index >= len(clips):
                return None
            return clips[index]

        def arrangement_length(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            return (int(params[0]), int(params[1]), float(clip.length))

        def arrangement_num_notes(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            notes = clip.get_notes_extended(0, 128, 0.0, float(clip.length))
            return num_notes_reply(int(params[0]), int(params[1]), notes)

        def arrangement_notes_window(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            window = int(params[2])
            from_pitch, pitch_span = int(params[3]), int(params[4])
            start, span = float(params[5]), float(params[6])
            notes = clip.get_notes_extended(from_pitch, pitch_span, start, span)
            return notes_window_reply(
                int(params[0]), int(params[1]), window, notes)

        self.osc_server.add_handler(
            "/live/arrangement_clip/get/length", arrangement_length)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/num_notes", arrangement_num_notes)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/notes_window", arrangement_notes_window)
