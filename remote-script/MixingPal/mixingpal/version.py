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
WIRE_VERSION = 5


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
