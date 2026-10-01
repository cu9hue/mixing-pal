from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .arrangement_replies import (
    arrangement_reply, cue_points_reply, identity_reply, timeline_fingerprint_reply,
    window_of)
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

    It also answers `/live/mixingpal/get/cue_points`. Locators are a song
    property rather than a track one, but they are what the arrangement is
    divided into, and they are here for the same datagram reason everything
    else in this file is: upstream's unbounded handler goes silent on a set
    with too many of them.

    Upstream's `create_track_callback` answers an out-of-range track with an
    `Index out of range` ERROR reply (confirmed against Live 12 on
    2026-08-30, probing track 2 of a two-track set). This handler sends
    nothing instead. Both look the same to the client -- neither resolves the
    pending request, so it times out into a named gap -- but the two families
    are not identical on the wire, and this silence is deliberate rather than
    an oversight to "fix" later.

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

        def clips_of(track):
            # Live raises on group arrangement_clips; their children own the placements.
            return () if track.is_foldable else track.arrangement_clips

        def arrangement(params: Tuple[Any]):
            if len(params) != 3:
                return None
            try:
                track_index = int(params[0])
                start, span = max(0, int(params[1])), max(0, int(params[2]))
            except (TypeError, ValueError):
                return None
            track = track_at(track_index)
            if track is None:
                return None
            # One access to the Live list: `len` is O(1) on it and
            # `window_of` reads clip properties only inside the window, so a
            # page costs three property reads per clip DELIVERED rather than
            # three per clip on the track.
            clips = clips_of(track)
            records = window_of(clips, start, span)
            return arrangement_reply(track_index, start, len(clips), records)

        self.osc_server.add_handler(
            "/live/mixingpal/get/arrangement", arrangement)

        def arrangement_fingerprint(params: Tuple[Any]):
            if len(params) != 1:
                return None
            try:
                track_index = int(params[0])
            except (TypeError, ValueError):
                return None
            track = track_at(track_index)
            if track is None:
                return None
            return timeline_fingerprint_reply(track_index, clips_of(track))

        self.osc_server.add_handler(
            "/live/mixingpal/get/arrangement/fingerprint", arrangement_fingerprint)

        def arrangement_clip_at(params):
            """The arrangement clip at (track, index), or None.

            None sends no reply, which is how "there is no clip there"
            reaches the client -- the same way an empty session slot does.
            """
            if len(params) < 2:
                return None
            try:
                track_index, index = int(params[0]), int(params[1])
            except (TypeError, ValueError):
                return None
            track = track_at(track_index)
            if track is None:
                return None
            clips = clips_of(track)
            if index < 0 or index >= len(clips):
                return None
            return clips[index]

        def arrangement_identity(params: Tuple[Any]):
            """One clip's `(name, start_time, end_time)`, on its own address.

            The map cannot serve this. Its key is `(track, start)`, so an
            identity read phrased as a span-1 page of the same track joins a
            span-48 page whenever `index == start` and takes its reply. See
            `identity_reply`, and `/live/mixingpal/get/device/identity` in
            `rack.py`, which exists for exactly this reason.
            """
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            return identity_reply(int(params[0]), int(params[1]), clip)

        self.osc_server.add_handler(
            "/live/mixingpal/get/arrangement/identity", arrangement_identity)

        def cue_points(params: Tuple[Any]):
            """Every locator this set has room to send, plus the true count.

            Upstream's `/live/song/get/cue_points` caps nothing, so a set
            with enough locators overfills the datagram and Live's sendto
            raises -- the client then receives nothing, which looks exactly
            like a set with no locators at all. Bounded, not paged: the poll
            loop fires this every five seconds and never awaits a reply, so
            there is no paging loop to drive.
            """
            return cue_points_reply(self.song.cue_points)

        self.osc_server.add_handler(
            "/live/mixingpal/get/cue_points", cue_points)

        def arrangement_length(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None:
                return None
            return (int(params[0]), int(params[1]), float(clip.length))

        def arrangement_num_notes(params: Tuple[Any]):
            clip = arrangement_clip_at(params)
            if clip is None or not bool(getattr(clip, "is_midi_clip", False)):
                return None
            notes = clip.get_notes_extended(0, 128, 0.0, float(clip.length))
            return num_notes_reply(int(params[0]), int(params[1]), notes)

        def arrangement_notes_window(params: Tuple[Any]):
            if len(params) != 7:
                return None
            clip = arrangement_clip_at(params)
            if clip is None or not bool(getattr(clip, "is_midi_clip", False)):
                return None
            try:
                window = int(params[2])
                from_pitch, pitch_span = int(params[3]), int(params[4])
                start, span = float(params[5]), float(params[6])
            except (TypeError, ValueError):
                return None
            notes = clip.get_notes_extended(from_pitch, pitch_span, start, span)
            return notes_window_reply(
                int(params[0]), int(params[1]), window, notes)

        self.osc_server.add_handler(
            "/live/arrangement_clip/get/length", arrangement_length)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/num_notes", arrangement_num_notes)
        self.osc_server.add_handler(
            "/live/arrangement_clip/get/notes_window", arrangement_notes_window)
