#!/bin/bash
# ============================================================================
#  Noctura Screen Saver - Installer (macOS)
#  Copies Noctura.saver (sitting next to this script) into your personal
#  Screen Savers folder and opens the Screen Saver settings so you can pick it.
#  No admin rights needed — it installs for the current user only.
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
SAVER="$DIR/Noctura.saver"
DEST="$HOME/Library/Screen Savers"

if [[ ! -d "$SAVER" ]]; then
    echo "ERROR: Noctura.saver was not found next to this script."
    echo "Unzip the whole download and run Install-Noctura.command from that folder."
    read -n 1 -s -r -p "Press any key to close."
    exit 1
fi

echo "Installing Noctura.saver for $(whoami)..."
mkdir -p "$DEST"
rm -rf "$DEST/Noctura.saver"
cp -R "$SAVER" "$DEST/Noctura.saver"

# The download carries macOS quarantine; strip it so the saver loads without
# the "unidentified developer" block (the build is unsigned — no paid Dev ID).
xattr -dr com.apple.quarantine "$DEST/Noctura.saver" 2>/dev/null || true

echo "Installed to: $DEST/Noctura.saver"
echo "Opening Screen Saver settings — choose \"Noctura\", then Options for scenes."
open "x-apple.systempreferences:com.apple.ScreenSaver-Settings.extension" 2>/dev/null \
  || open "/System/Library/PreferencePanes/DesktopScreenEffectsPref.prefPane" 2>/dev/null || true

echo
echo "Done. If Noctura doesn't appear immediately, quit and reopen System Settings."
read -n 1 -s -r -p "Press any key to close."
