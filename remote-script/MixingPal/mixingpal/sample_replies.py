"""Played-region rules and reply shaping for /live/mixingpal/get/sample.

Free of Live imports, like rack_paths.py, so tests/test_sample_replies.py
exercises it with fakes. sample.py holds the handler.

Units: a warped clip's markers are beats, an unwarped clip's are seconds,
a Simpler's are frames. Intervals are half-open. Live maps each endpoint to
frames itself (beat_to_sample_time / seconds_to_sample_time), so no warp
maths is reproduced here or in the app.
"""
from .rack_paths import MAX_REPLY_BYTES, osc_string_bytes

SESSION, ARRANGEMENT, DEVICE = 0, 1, 2
CLASSIC, ONE_SHOT, SLICING = 0, 1, 2
SIMPLER, SAMPLER = "OriginalSimpler", "MultiSampler"

# The address and type tags ride outside the fields counted below.
HEADER_BYTES = 64


def read(obj, name):
    """obj.name, or None when Live raises or lacks it. A handler never raises."""
    try:
        return getattr(obj, name)
    except Exception:
        return None


def call(obj, name):
    """A value Live exposes as a property on one object and a function on
    another (gain_display_string on Clip and on Sample)."""
    value = read(obj, name)
    if callable(value):
        try:
            return value()
        except Exception:
            return None
    return value


def status_reply(key, status):
    return tuple(key) + (status,)


def played_intervals(looping, start_marker, loop_start, loop_end, length=None):
    """The source intervals a clip plays, in playback order, or None.

    `length` is an arrangement placement's length in source units; a session
    clip has none and gets what it can play when launched. Overlapping or
    touching intervals merge.
    """
    if looping is None or loop_start is None or loop_end is None or loop_end <= loop_start:
        return None
    if length is not None and length <= 0:
        return None
    if not looping:
        end = loop_end if length is None else min(loop_end, loop_start + length)
        return [(loop_start, end)]
    if start_marker is None or start_marker >= loop_end:
        return None
    if length is None:
        # An intro before the loop plays once; only the loop repeats.
        if start_marker < loop_start:
            return [(start_marker, loop_start), (loop_start, loop_end)]
        return [(loop_start, loop_end)]
    first = (start_marker, min(loop_end, start_marker + length))
    remaining = length - (loop_end - start_marker)
    if remaining <= 0:
        return [first]
    second = (loop_start, min(loop_end, loop_start + remaining))
    if second[0] <= first[1] and first[0] <= second[1]:
        return [(min(first[0], second[0]), max(first[1], second[1]))]
    return [first, second]


def source_length(start_time, end_time, warping, tempo):
    """A placement's length in the clip's source units, or None."""
    if start_time is None or end_time is None or end_time <= start_time:
        return None
    beats = end_time - start_time
    if warping is True:
        return beats
    if warping is False and tempo:
        return beats * 60.0 / tempo
    return None


def map_intervals(intervals, to_frames, total_frames):
    """(source_start, source_end, frame_start, frame_end) per interval, or []
    when any endpoint cannot be mapped. Never widens to the whole file."""
    if not intervals or to_frames is None:
        return []
    out = []
    for start, end in intervals:
        try:
            a, b = int(round(to_frames(start))), int(round(to_frames(end)))
        except Exception:
            return []
        if total_frames is not None:
            a, b = max(0, min(a, total_frames)), max(0, min(b, total_frames))
        if b <= a:
            return []
        out.append((start, end, a, b))
    return out


def reply_bytes(fields):
    return HEADER_BYTES + sum(osc_string_bytes(f) if isinstance(f, str) else 9 for f in fields)


def ok_reply(key, settings, mapped, extra):
    flat = tuple(value for interval in mapped for value in interval)
    reply = tuple(key) + ("ok",) + tuple(settings) + (len(mapped),) + flat + tuple(extra)
    if reply_bytes(reply) > MAX_REPLY_BYTES:
        return status_reply(key, "path_too_long")
    return reply


def clip_reply(key, clip, arrangement, tempo):
    if read(clip, "is_audio_clip") is not True:
        return status_reply(key, "not_audio_clip")
    warping = read(clip, "warping")
    looping = read(clip, "looping")
    start_marker, loop_start, loop_end = (read(clip, n) for n in ("start_marker", "loop_start", "loop_end"))
    placement = (read(clip, "start_time"), read(clip, "end_time")) if arrangement else (None, None)
    intervals = None
    if not arrangement:
        intervals = played_intervals(looping, start_marker, loop_start, loop_end)
    else:
        length = source_length(placement[0], placement[1], warping, tempo)
        if length is not None:
            intervals = played_intervals(looping, start_marker, loop_start, loop_end, length)
    to_frames = None
    if warping is True:
        to_frames = read(clip, "beat_to_sample_time")
    elif warping is False:
        to_frames = read(clip, "seconds_to_sample_time")
    total = read(clip, "sample_length")
    settings = (read(clip, "file_path"), read(clip, "sample_rate"), total, warping,
                read(clip, "warp_mode"), call(clip, "gain_display_string"),
                read(clip, "pitch_coarse"), read(clip, "pitch_fine"))
    extra = (looping, read(clip, "muted"), start_marker, loop_start, loop_end,
             placement[0], placement[1], tempo)
    return ok_reply(key, settings, map_intervals(intervals, to_frames, total), extra)


def parameters_of(device):
    """name -> (value, min, max) for every readable parameter."""
    out = {}
    for p in read(device, "parameters") or []:
        name = read(p, "name")
        if name is not None:
            out[name] = (read(p, "value"), read(p, "min"), read(p, "max"))
    return out


def normalised(params, name):
    value, lo, hi = params.get(name, (None, None, None))
    if value is None or lo is None or hi is None or hi <= lo:
        return None
    return (value - lo) / (hi - lo)


def simpler_region(mode, start_marker, end_marker, s_start, s_length, loop_on, loop_length):
    """Frames ([start, end), held-loop [start, end) or None) one note plays.

    Simpler's end marker is the last frame it plays, so the half-open end is
    one past it. In Classic, S Start and S Length are shares of the span
    between the markers, and S Loop Length a share of the played part at its
    end. Checked against Live 12 in the PR's real-Live pass.
    """
    if start_marker is None or end_marker is None:
        return None, None
    lo, hi = start_marker, end_marker + 1
    if hi <= lo:
        return None, None
    if mode is None:
        return None, None
    if mode != CLASSIC:
        return (lo, hi), None
    if s_start is None or s_length is None:
        # The narrowed region is unknown; never fall back to the whole sample.
        return None, None
    span = hi - lo
    start = lo + s_start * span
    end = min(hi, start + s_length * span)
    if end <= start:
        return None, None
    loop = None
    if loop_on and loop_length is not None:
        loop = (end - loop_length * (end - start), end)
    return (start, end), loop


def simpler_reply(key, device):
    kind = read(device, "class_name")
    if kind == SAMPLER:
        return status_reply(key, "sampler_not_readable")
    if kind != SIMPLER:
        return status_reply(key, "not_a_simpler")
    if read(device, "multi_sample_mode"):
        return status_reply(key, "multisample_not_readable")
    sample = read(device, "sample")
    if sample is None:
        return status_reply(key, "no_sample")
    params = parameters_of(device)
    mode = read(device, "playback_mode")
    loop_on = normalised(params, "S Loop On")
    region, loop = simpler_region(
        mode, read(sample, "start_marker"), read(sample, "end_marker"),
        normalised(params, "S Start"), normalised(params, "S Length"),
        bool(loop_on) if loop_on is not None else False, normalised(params, "S Loop Length"))
    total = read(sample, "length")
    mapped = [] if region is None else map_intervals([region], lambda frame: frame, total)
    slices = read(sample, "slices")
    try:
        slice_count = None if slices is None else len(slices)
    except Exception:
        slice_count = None
    loop_frames = (None, None) if loop is None else (int(round(loop[0])), int(round(loop[1])))
    settings = (read(sample, "file_path"), read(sample, "sample_rate"), total,
                read(sample, "warping"), read(sample, "warp_mode"),
                call(sample, "gain_display_string"),
                params.get("Transpose", (None,))[0], params.get("Detune", (None,))[0])
    extra = (mode, slice_count) + loop_frames
    return ok_reply(key, settings, mapped, extra)
