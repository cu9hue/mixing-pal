from typing import Tuple, Any
from ..abletonosc.handler import AbletonOSCHandler

# This script is installed by copying it into Live's Remote Scripts folder --
# a separately deployed artefact that can fall out of step with the app. The
# app polls WIRE_VERSION at connect and compares it against
# shared/wire-version.json; a mismatch (or no reply at all, from a script too
# old to have this handler) means the two sides may disagree about wire
# shapes like mixer_data's argument count. Pinned against
# shared/wire-version.json by a Rust test -- see src-tauri's
# wire_version_matches_the_shared_manifest.
#
# Version 3 moved every device address from a top-level device index to a
# dotted path string, so a stale script would answer a path query with a
# raise and the client would read it as a lost reply.
#
# Version 4 moved note reads onto /live/clip/get/num_notes and
# /live/clip/get/notes_window. A stale script knows neither address, so it
# answers no window at all and get_clip_notes returns nothing after
# exhausting its retry budget. Clip reads do not degrade here, they stop;
# reinstalling is the fix, which is what the banner asks for.
#
# Version 5 added /live/mixingpal/get/arrangement and the
# /live/arrangement_clip/get/* family. A stale script knows neither, so the
# arrangement map and arrangement note reads report a named gap while
# session, mixer and device reads keep working normally. Reinstalling is the
# fix, which is what the banner asks for.
#
# Version 6 adds loop boundaries to arrangement records. A stale script has
# the old three-field records, which must not be decoded as loop metadata.
# Version 7 adds session loop metadata, so source notes are never presented
# as the whole clip's playback. Version 8 makes arrangement timing use the
# clip's end_time rather than its source-loop length. Version 9 adds each
# arrangement placement's mute and MIDI type. Version 10 adds a Drum Rack
# pad's loaded sample-file name when Live exposes one. Version 11 marks Rack
# devices inside a Rack listing, so nested Drum Racks can be opened. Version
# 12 adds /live/mixingpal/get/set_identity: the set's stored id, name, and
# path. A stale script knows no such address, so the app never learns which
# set is open and nothing per-set can be saved; the banner asks for the
# reinstall. Version 13 adds paged session and device lists and rack device
# continuation. Version 14 adds each device's on/off state, kind, and class
# name to chain listings, the automation state of parameters, the track,
# return, and master mixer reads, and each note's probability; a stale script
# answers the old record shapes, which must not be decoded as the new ones.
# Version 15 adds /live/mixingpal/get/sample: an audio clip's or Simpler's
# file, settings and played region. A stale script knows no such address,
# so get_sample reports no_reply and every other read keeps working.
WIRE_VERSION = 15


class VersionHandler(AbletonOSCHandler):
    """Exposes this script's own wire version, so the app can detect a stale
    install instead of silently misdecoding replies (mixer_data's 2-vs-3
    argument incident)."""

    def __init__(self, manager):
        super().__init__(manager)
        self.class_identifier = "mixingpal"

    def init_api(self):
        def version_get(params: Tuple[Any] = ()):
            return (WIRE_VERSION,)

        self.osc_server.add_handler(
            "/live/mixingpal/get/version", version_get)
