from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler
from .rack_paths import parse_path, resolve
from .sample_replies import ARRANGEMENT, DEVICE, SESSION, clip_reply, frames_reply, simpler_reply, status_reply


class SampleHandler(AbletonOSCHandler):
    """Answers /live/mixingpal/get/sample (track, kind, target).

    kind 0 is a session slot, 1 an arrangement index, 2 a device path in the
    dotted form rack.py reads. target is always a string, so the request
    keys on Args(3) whatever the kind. The rules live in sample_replies.py;
    this file only finds the object. Every miss is a named status rather
    than silence, because silence reads as a lost reply.
    """

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "sample"

    def init_api(self):
        def clip_of(track, kind, target):
            """(clip, None), or (None, status) when there is none."""
            if not target.isascii() or not target.isdigit() or len(target) > 10:
                return None, "no_such_target"
            index = int(target)
            if kind == SESSION:
                slots = track.clip_slots
                if index >= len(slots):
                    return None, "no_such_target"
                if not slots[index].has_clip:
                    return None, "empty_slot"
                return slots[index].clip, None
            try:
                clips = track.arrangement_clips
            except RuntimeError:
                return None, "no_such_target"
            if index >= len(clips):
                return None, "no_such_target"
            return clips[index], None

        def target_of(track, kind, target, key):
            if kind == DEVICE:
                path = parse_path(target)
                if path is None:
                    return status_reply(key, "no_such_target")
                try:
                    return simpler_reply(key, resolve(track, path))
                except (IndexError, AttributeError, RuntimeError):
                    return status_reply(key, "no_such_target")
            clip, status = clip_of(track, kind, target)
            if status is not None:
                return status_reply(key, status)
            return clip_reply(key, clip, kind == ARRANGEMENT, self.song.tempo)

        def sample(params: Tuple[Any] = ()):
            if len(params) != 3:
                return None
            try:
                track_index, kind, target = int(params[0]), int(params[1]), str(params[2])
            except (TypeError, ValueError):
                return None
            if kind not in (SESSION, ARRANGEMENT, DEVICE):
                return None
            tracks = self.song.tracks
            if track_index < 0 or track_index >= len(tracks):
                return None
            try:
                return target_of(tracks[track_index], kind, target, (track_index, kind, target))
            except Exception:
                # Never raise out of a handler; see view.py.
                return None

        def frames(params: Tuple[Any] = ()):
            if len(params) != 4:
                return None
            try:
                track_index, kind, target, beats = int(params[0]), int(params[1]), str(params[2]), str(params[3])
            except (TypeError, ValueError):
                return None
            if kind not in (SESSION, ARRANGEMENT, DEVICE):
                return None
            tracks = self.song.tracks
            if track_index < 0 or track_index >= len(tracks):
                return None
            key = (track_index, kind, target, beats)
            try:
                if kind == DEVICE:
                    return status_reply(key, "no_such_target")
                clip, status = clip_of(tracks[track_index], kind, target)
                if status is not None:
                    return status_reply(key, status)
                return frames_reply(key, clip, beats)
            except Exception:
                # Never raise out of a handler; see view.py.
                return None

        self.osc_server.add_handler("/live/mixingpal/get/sample", sample)
        self.osc_server.add_handler("/live/mixingpal/get/sample/frames", frames)
