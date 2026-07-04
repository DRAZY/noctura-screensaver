#!/bin/bash
# ============================================================================
#  Noctura Screen Saver - Uninstaller (macOS)
#  Removes Noctura.saver from your personal Screen Savers folder. Also clears
#  the saved Noctura preferences. No admin rights needed.
# ============================================================================
set -euo pipefail

DEST="$HOME/Library/Screen Savers/Noctura.saver"

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
