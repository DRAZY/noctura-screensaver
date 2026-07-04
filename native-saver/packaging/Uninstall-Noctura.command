#!/bin/bash
# ============================================================================
#  Noctura Screen Saver - Uninstaller (macOS)
#  Removes Noctura.saver from your personal Screen Savers folder. Also clears
#  the saved Noctura preferences. No admin rights needed.
# ============================================================================
set -euo pipefail

DEST="$HOME/Library/Screen Savers/Noctura.saver"

# Stop anything still running the bundle first, so removal is clean and the host
# doesn't keep an old copy alive in memory. Both relaunch on demand.
osascript -e 'tell application "System Settings" to quit' 2>/dev/null || true
osascript -e 'tell application "System Preferences" to quit' 2>/dev/null || true
killall legacyScreenSaver 2>/dev/null || true
killall ScreenSaverEngine 2>/dev/null || true
sleep 1

if [[ -d "$DEST" ]]; then
    rm -rf "$DEST"
    echo "Removed: $DEST"
else
    echo "Noctura was not installed (nothing to remove)."
fi

# Forget the saved settings (scene, colors, clock, performance). Harmless if
# absent. The domain matches the saver's ScreenSaverDefaults module name.
defaults delete com.aurora.screensaver 2>/dev/null || true

echo
echo "If Noctura was your active screen saver, open Screen Saver settings"
echo "and pick a different one."
read -n 1 -s -r -p "Press any key to close."
