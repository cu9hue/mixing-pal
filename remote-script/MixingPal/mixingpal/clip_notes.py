from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .clip_replies import notes_window_reply, session_clips_reply, session_snapshot_reply


class ClipNotesHandler(AbletonOSCHandler):
    """Bounded session reads with note windows and content snapshots.
    Snapshot checks keep note pages from different edits out of one answer."""

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
            if clip is None or not bool(getattr(clip, "is_midi_clip", False)):
                return None
            notes = clip.get_notes_extended(
                pitch_start, pitch_span, time_start, time_span)
            return notes_window_reply(track_index, clip_index, window, notes)

        def num_notes(params: Tuple[Any]):
            indices = clip_indices(params)
            if indices is None:
                return None
            track_index, clip_index = indices
            tracks = self.song.tracks
            if not 0 <= track_index < len(tracks):
                return None
            track = tracks[track_index]
            slots = () if bool(getattr(track, "is_foldable", False)) else track.clip_slots
            if not 0 <= clip_index < len(slots):
                return None
            clip = slots[clip_index].clip
            if clip is None:
                return (track_index, clip_index, "empty_slot")
            if not bool(clip.is_midi_clip):
                return (track_index, clip_index, "not_midi_clip")
            notes = clip.get_notes_extended(0, 128, 0.0, clip.length)
            return session_snapshot_reply(track_index, clip_index, clip, notes)

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

        def session_clips(params: Tuple[Any]):
            if len(params) != 3:
                return None
            try:
                track_index, start, limit = map(int, params)
            except (TypeError, ValueError, OverflowError):
                return None
            if not 0 <= track_index < len(self.song.tracks) or start < 0 or limit < 1:
                return None
            track = self.song.tracks[track_index]
            slots = () if bool(getattr(track, "is_foldable", False)) else track.clip_slots
            return session_clips_reply(track_index, start, limit, slots)

        self.osc_server.add_handler("/live/mixingpal/get/session/clips", session_clips)

        self.osc_server.add_handler(
            "/live/clip/get/notes_window", notes_window)
        self.osc_server.add_handler("/live/clip/get/num_notes", num_notes)
        self.osc_server.add_handler("/live/mixingpal/get/clip/loop_region", loop_region)
