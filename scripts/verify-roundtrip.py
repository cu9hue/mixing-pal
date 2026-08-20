#!/usr/bin/env python3
"""Manual verification: confirm the MixingPal Remote Script answers over OSC.

Prerequisites (cannot be done by this script):
  1. Restart Ableton Live.
  2. Preferences > Link/Tempo/MIDI > Control Surface > select "MixingPal".
  3. Open any Live set.

Usage:
  python3 scripts/verify-roundtrip.py

Expected output: a datagram containing b'/live/song/get/tempo' and the
set's current BPM as an OSC float argument, followed by replies for the
master/return endpoints added in Task 2, and then replies for the
mixer/device-range endpoints added in Task 3 (see below). A timeout means
the Control Surface is not selected, or Live was not restarted after
installing the Remote Script.

Master/return checks (Task 2) and what to expect from each reply:
  /live/master/get/volume           -- float with NO index, ~0.85 at unity gain.
  /live/master/get/output_meter_level -- float with NO index; 0.0 while
                                          stopped, rises above 0 during playback.
  /live/return/get/num_returns      -- single int with NO index: the return
                                          track count. Add/remove a return
                                          track and re-run to confirm it changes.

Mixer/device-range checks (Task 3) and what to expect from each reply:
  /live/track/get/volume_db 0
      -- (track_index, "<N> dB" string). Set track 0's fader to exactly
         0 dB in Live and confirm the string reads "0.0 dB", matching what
         Live's own fader tooltip displays. 1 leading key arg (the index).
  /live/track/get/mixer_data 0 -1
      -- a FLAT, KEYLESS list of (volume, panning) floats, two per track,
         in index order, covering every track (-1 means "to the end", like
         upstream's track_data). No index/range is echoed back.
  /live/device/get/parameters/value_range 1 0 0 32
      -- (track=1, device=0, param_start=0, <up to 32 float values>).
         3 leading key args. Put an Instrument Rack on track index 1 first;
         if it has fewer than 32 parameters this simply returns fewer
         values. Re-run with param_start=32 and confirm it returns the
         NEXT window of parameters, not a repeat of the first 32 -- that
         is the whole point of the ranged form (upstream's single-shot
         /live/device/get/parameters/value can exceed the macOS 9216-byte
         UDP datagram cap on a large Rack and silently drop the whole
         reply).

Clip paging checks (wire version 4) and what to expect:
  /live/clip/get/num_notes 0 0
      -- (track=0, clip=0, <note count>). 2 leading key args. Put a MIDI
         clip in track 0's first clip slot first; an EMPTY slot answers
         nothing at all, which is correct and is how "there is no clip
         here" reaches the client. Compare the count against Live's own
         note display. This is what lets the client size its note windows
         in one pass: without it, reading a dense clip meant asking for the
         whole clip, waiting out a full timeout on a reply Live could not
         send, and halving until something answered.
  /live/clip/get/notes_window 0 0 7 0 128 0.0 4.0
      -- (track=0, clip=0, window=7, *notes) for the first 4 beats. THE 7
         MUST COME BACK AS 7: it is the client's own window ordinal, echoed
         unchanged, and it is the only thing that tells two windows of one
         clip apart. Without it a window the client gave up on can come
         back late and resolve a different window's request, and that
         window is then recorded as answered-with-nothing. Re-run with a
         different ordinal and confirm it echoes that one instead.
"""
import socket
import struct
import sys

LISTEN_ADDR = ("127.0.0.1", 11001)
REMOTE_ADDR = ("127.0.0.1", 11000)
TIMEOUT_SECONDS = 3

# Minimal OSC message: address "/live/song/get/tempo" (padded to a multiple
# of 4 bytes with NUL), followed by the typetag string "," (no arguments,
# also padded to a multiple of 4 bytes).
REQUEST = b"/live/song/get/tempo\x00\x00\x00\x00,\x00\x00\x00"

# Additional endpoints added in Task 2 (master/return track access). None of
# these take arguments.
MASTER_RETURN_ADDRESSES = (
    "/live/master/get/volume",
    "/live/master/get/output_meter_level",
    "/live/return/get/num_returns",
)

# Additional endpoints added in Task 3 (mixer + ranged device parameters).
# Each entry is (address, args). See the module docstring above for what to
# expect back from each one.
MIXER_DEVICE_RANGE_REQUESTS = (
    ("/live/track/get/volume_db", (0,)),
    ("/live/track/get/mixer_data", (0, -1)),
    ("/live/device/get/parameters/value_range", (1, 0, 0, 32)),
    ("/live/clip/get/num_notes", (0, 0)),
    ("/live/clip/get/notes_window", (0, 0, 7, 0, 128, 0.0, 4.0)),
)


def _pad(b: bytes) -> bytes:
    return b + b"\x00" * (4 - len(b) % 4)


def build_osc_message(address: str, *args) -> bytes:
    """Build an OSC message for `address` with zero or more int/float args.

    Each arg is encoded as OSC type 'i' (32-bit big-endian int) or 'f'
    (32-bit big-endian float) per its Python type. The typetag string and
    each argument are individually padded/sized to a 4-byte boundary, per
    the OSC 1.0 spec.
    """
    typetags = ","
    arg_bytes = b""
    for arg in args:
        if isinstance(arg, float):
            typetags += "f"
            arg_bytes += struct.pack(">f", arg)
        elif isinstance(arg, int):
            typetags += "i"
            arg_bytes += struct.pack(">i", arg)
        else:
            raise TypeError("Unsupported OSC arg type: %r" % (arg,))
    return _pad(address.encode()) + _pad(typetags.encode()) + arg_bytes


def request(sock: socket.socket, address: str, *args):
    sock.sendto(build_osc_message(address, *args), REMOTE_ADDR)
    return sock.recvfrom(9216)


def main() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(LISTEN_ADDR)
    sock.settimeout(TIMEOUT_SECONDS)
    sock.sendto(REQUEST, REMOTE_ADDR)
    try:
        data, addr = sock.recvfrom(1024)
    except socket.timeout:
        print(
            "Timed out waiting for a reply on "
            f"{LISTEN_ADDR[0]}:{LISTEN_ADDR[1]}.\n"
            "Is MixingPal selected as a Control Surface, and was Live "
            "restarted after installing the Remote Script?",
            file=sys.stderr,
        )
        return 1
    print((data, addr))

    for address in MASTER_RETURN_ADDRESSES:
        try:
            data, addr = request(sock, address)
        except socket.timeout:
            print(
                f"Timed out waiting for a reply to {address} on "
                f"{LISTEN_ADDR[0]}:{LISTEN_ADDR[1]}.",
                file=sys.stderr,
            )
            return 1
        print((address, data, addr))

    for address, args in MIXER_DEVICE_RANGE_REQUESTS:
        try:
            data, addr = request(sock, address, *args)
        except socket.timeout:
            print(
                f"Timed out waiting for a reply to {address} {args} on "
                f"{LISTEN_ADDR[0]}:{LISTEN_ADDR[1]}.",
                file=sys.stderr,
            )
            return 1
        print((address, args, data, addr))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
