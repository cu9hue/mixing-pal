#!/usr/bin/env python3
"""Manual verification: confirm the AbletonCopilot Remote Script answers over OSC.

Prerequisites (cannot be done by this script):
  1. Restart Ableton Live.
  2. Preferences > Link/Tempo/MIDI > Control Surface > select "AbletonCopilot".
  3. Open any Live set.

Usage:
  python3 scripts/verify-roundtrip.py

Expected output: a datagram containing b'/live/song/get/tempo' and the
set's current BPM as an OSC float argument. A timeout means the Control
Surface is not selected, or Live was not restarted after installing the
Remote Script.
"""
import socket
import sys

LISTEN_ADDR = ("127.0.0.1", 11001)
REMOTE_ADDR = ("127.0.0.1", 11000)
TIMEOUT_SECONDS = 3

# Minimal OSC message: address "/live/song/get/tempo" (padded to a multiple
# of 4 bytes with NUL), followed by the typetag string "," (no arguments,
# also padded to a multiple of 4 bytes).
REQUEST = b"/live/song/get/tempo\x00\x00\x00\x00,\x00\x00\x00"


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
            "Is AbletonCopilot selected as a Control Surface, and was Live "
            "restarted after installing the Remote Script?",
            file=sys.stderr,
        )
        return 1
    print((data, addr))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
