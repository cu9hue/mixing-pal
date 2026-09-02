from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .clip_replies import notes_window_reply, num_notes_reply


class ClipNotesHandler(AbletonOSCHandler):
    """Two endpoints that together let a clip be read in one pass.

    `/live/clip/get/num_notes` reports how many notes a clip holds, so the
    client can size its windows up front instead of discovering them by
    timing out. `/live/clip/get/notes_window` is upstream's ranged note
    query with the window echoed back, so a window the client gave up on
    cannot resolve a different window's request.

    Note queries are ranged because a reply past the 9216-byte macOS UDP cap
    makes sendto raise and the client receives nothing at all -- silence
    indistinguishable from a lost datagram. Without a count the client
    cannot know how wide a window may be, and can only find out by asking
    for one Live cannot answer and waiting out its timeout.

    Counting is not free -- `get_notes_extended` materialises every note
    just to take its length -- but it is cheaper for LIVE than the
    discovery it removes: each unanswerable probe runs that same extraction
    inside Live's tick and only then fails at the send.

    The range mirrors exactly what the client will go on to tile: pitches
    0..128 (upstream's 127 default silently omits pitch 127) over
    [0, clip.length), which is the same span `/live/clip/get/length`
    reports. Counting a wider range would over-report and cost the client
    windows it does not need.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "clip_notes"

    def init_api(self):
        def clip_indices(params):
            if len(params) != 2:
                return None
            try:
                return int(params[0]), int(params[1])
            except (TypeError, ValueError):
                return None

        def clip_at(track_index, clip_index):
            """The clip at (track, clip), or None if there isn't one.

            None rather than an exception, and every caller here returns it
            straight through, because `osc_server.process()` drains the
            socket in one `while True: recvfrom(...)` loop whose only
            exception handling wraps that whole loop. A handler that raises
            does not merely fail its own request: it breaks out of the
            drain, and every datagram still queued behind it waits for the
            next 100 ms tick. Upstream's `create_clip_callback` raises
            AttributeError on an empty clip slot, and
            `/live/clip/get/length` inherits that.

            That cost one tick while a clip read sent one such request. A
            read now sends the length and the count together, and pages its
            windows concurrently, so a single empty slot could abort the
            drain many times over. `process_message` sends nothing for a
            None return, which is the same silence the client already reads
            as "there is no clip here", at no cost to anything queued
            behind it.
            """
            tracks = self.song.tracks
            if not 0 <= track_index < len(tracks):
                return None
            slots = tracks[track_index].clip_slots
            if not 0 <= clip_index < len(slots):
                return None
            return slots[clip_index].clip

        def notes_window(params: Tuple[Any]):
            """Upstream's ranged note query, with the window echoed back.

            `/live/clip/get/notes` replies `(track, clip, *notes)` and says
            nothing about WHICH window it answers. Every window of one clip
            therefore looks identical to the client's request table, so a
            window the client gave up on can come back late and resolve
            whichever window is waiting now. Echoing the client's own window
            ordinal makes them distinct -- exactly what
            `/live/device/get/parameters/*_range` already does by echoing
            `start`.

            The ordinal is opaque here. Live never interprets it; it only
            has to come back unchanged.
            """
            if len(params) != 7:
                return None
            try:
                track_index, clip_index, window = (
                    int(params[0]), int(params[1]), int(params[2]))
                pitch_start, pitch_span = int(params[3]), int(params[4])
                time_start, time_span = float(params[5]), float(params[6])
            except (TypeError, ValueError):
                return None
            clip = clip_at(track_index, clip_index)
            if clip is None:
                return None
            notes = clip.get_notes_extended(
                pitch_start, pitch_span, time_start, time_span)
            return notes_window_reply(track_index, clip_index, window, notes)

        def num_notes(params: Tuple[Any]):
            indices = clip_indices(params)
            if indices is None:
                return None
            track_index, clip_index = indices
            clip = clip_at(track_index, clip_index)
            if clip is None:
                return None
            notes = clip.get_notes_extended(0, 128, 0.0, clip.length)
            return num_notes_reply(track_index, clip_index, notes)

        def loop_region(params: Tuple[Any]):
            indices = clip_indices(params)
            if indices is None:
                return None
            track_index, clip_index = indices
            clip = clip_at(track_index, clip_index)
            if clip is None:
                return None
            looping = bool(clip.looping)
            if looping:
                start, end = float(clip.loop_start), float(clip.loop_end)
            else:
                start, end = 0.0, 0.0
            return (track_index, clip_index, looping, start, end)

        self.osc_server.add_handler(
            "/live/clip/get/notes_window", notes_window)
        self.osc_server.add_handler("/live/clip/get/num_notes", num_notes)
        self.osc_server.add_handler("/live/mixingpal/get/clip/loop_region", loop_region)
