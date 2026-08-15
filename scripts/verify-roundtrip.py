#!/usr/bin/env python3
"""Manual verification: confirm the AbletonCopilot Remote Script answers over OSC.

Prerequisites (cannot be done by this script):
  1. Restart Ableton Live.
  2. Preferences > Link/Tempo/MIDI > Control Surface > select "AbletonCopilot".
  3. Open any Live set.

Usage:
  python3 scripts/verify-roundtrip.py

Expected output: a datagram containing b'/live/song/get/tempo' and the
set's current BPM as an OSC float argument, followed by replies for the
master/return endpoints added in Task 2 (see below). A timeout means the
Control Surface is not selected, or Live was not restarted after installing
the Remote Script.

Master/return checks (Task 2) and what to expect from each reply:
  /live/master/get/volume           -- float with NO index, ~0.85 at unity gain.
  /live/master/get/output_meter_level -- float with NO index; 0.0 while
                                          stopped, rises above 0 during playback.
  /live/return/get/num_returns      -- single int with NO index: the return
                                          track count. Add/remove a return
                                          track and re-run to confirm it changes.
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

# Additional endpoints added in Task 2 (master/return track access). None of
# these take arguments.
MASTER_RETURN_ADDRESSES = (
    "/live/master/get/volume",
    "/live/master/get/output_meter_level",
    "/live/return/get/num_returns",
)


def _pad(b: bytes) -> bytes:
    return b + b"\x00" * (4 - len(b) % 4)


def build_osc_message(address: str) -> bytes:
    """Build a no-argument OSC message for `address`."""
    return _pad(address.encode()) + _pad(b",")


def request(sock: socket.socket, address: str):
    sock.sendto(build_osc_message(address), REMOTE_ADDR)
    return sock.recvfrom(2048)


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

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
