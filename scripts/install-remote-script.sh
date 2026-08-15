#!/usr/bin/env bash
set -euo pipefail
DEST="$HOME/Music/Ableton/User Library/Remote Scripts/AbletonCopilot"
SRC="$(cd "$(dirname "$0")/../remote-script/AbletonCopilot" && pwd)"
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
echo "Installed to $DEST"
echo "Restart Live, then choose AbletonCopilot under"
echo "Preferences > Link/Tempo/MIDI > Control Surface."
