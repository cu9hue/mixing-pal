#!/usr/bin/env bash
set -euo pipefail
: "${HOME:?HOME must be set and non-empty}"
DEST="$HOME/Music/Ableton/User Library/Remote Scripts/AbletonCopilot"
SRC="$(cd "$(dirname "$0")/../remote-script/AbletonCopilot" && pwd)"
mkdir -p "$DEST"
# --delete removes files no longer in SRC, but --exclude keeps rsync from
# ever touching logs/ (created inside DEST by a running Live session, not
# part of SRC) or __pycache__/ (never belongs in the installed copy).
# A prior `rm -rf "$DEST"` here deleted logs/ on every reinstall, breaking
# logging for a running Live session mid-build.
rsync -a --delete --exclude 'logs/' --exclude '__pycache__/' "$SRC/" "$DEST/"
echo "Installed to $DEST"
echo "Restart Live, then choose AbletonCopilot under"
echo "Preferences > Link/Tempo/MIDI > Control Surface."
