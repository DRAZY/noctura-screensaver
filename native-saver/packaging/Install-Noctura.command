#!/bin/bash
# ============================================================================
#  Noctura Screen Saver - Installer (macOS)
#  Copies Noctura.saver (sitting next to this script) into your personal
#  Screen Savers folder and opens the Screen Saver settings so you can pick it.
#  No admin rights needed — it installs for the current user only.
#
#  IMPORTANT: macOS runs screen savers inside a host process
#  (`legacyScreenSaver`) that caches the bundle in memory and does NOT reload it
#  when the file on disk changes. System Settings likewise caches its preview.
#  So a plain copy over an existing install leaves you looking at the OLD build.
#  This script therefore shuts both down BEFORE copying, so the fresh bundle is
#  the only thing left to load.
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

# 1. Retire anything holding the OLD bundle so the new one can't be shadowed by a
#    cached copy. Quit System Settings (releases its preview + bundle reference),
#    then stop the screensaver host process. Both relaunch clean on demand.
echo "Closing System Settings and the screen-saver host so the new build loads..."
osascript -e 'tell application "System Settings" to quit' 2>/dev/null || true
# Older macOS names it "System Preferences"; cover both.
osascript -e 'tell application "System Preferences" to quit' 2>/dev/null || true
killall legacyScreenSaver 2>/dev/null || true
killall ScreenSaverEngine 2>/dev/null || true
sleep 1

# 2. Install the fresh bundle.
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
echo "If you still see an old version: in Screen Saver settings pick a different"
echo "saver, then pick Noctura again (that forces the host to reload the bundle)."
read -n 1 -s -r -p "Press any key to close."
