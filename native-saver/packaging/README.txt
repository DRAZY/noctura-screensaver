Noctura Screen Saver for macOS
==============================

A native Metal ScreenSaverView that installs into
System Settings > Screen Saver.


INSTALL
-------
1. Double-click  Install-Noctura.command
   (If macOS blocks it: right-click > Open, then confirm. Or run
    "Uninstall" the same way — both are plain shell scripts you can read.)
2. It copies Noctura into your Screen Savers folder and opens Screen Saver
   settings. Choose "Noctura", then click Options for scenes, colors, clock,
   and performance mode.

The build is unsigned (no paid Apple Developer ID), so macOS may warn on first
run. The installer strips the download quarantine for you; if you still see a
block, run in Terminal:
   xattr -dr com.apple.quarantine "$HOME/Library/Screen Savers/Noctura.saver"


UNINSTALL
---------
Double-click  Uninstall-Noctura.command
It removes Noctura.saver and clears its saved settings. If Noctura was your
active screen saver, pick a different one in Screen Saver settings.


NOTE ON THE OPTIONS BUTTON
--------------------------
macOS Sonoma and later can leave the Options sheet unresponsive because the
system's "legacyScreenSaver" host process gets stuck. If Options does nothing:
select a different screen saver, then select Noctura again. If it persists,
open Activity Monitor, quit "legacyScreenSaver", and reselect Noctura.
