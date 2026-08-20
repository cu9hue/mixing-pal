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
WIRE_VERSION = 2


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
