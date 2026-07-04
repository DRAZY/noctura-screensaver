Noctura Screen Saver for Windows
================================

A native Direct3D 11 screen saver. No runtime to install — D3D11 ships with
every supported version of Windows.

This folder contains both CPU builds; the installer picks the right one:
  Noctura-x64.scr / .exe     — Intel/AMD 64-bit PCs
  Noctura-arm64.scr / .exe   — Windows on ARM PCs


INSTALL
-------
1. Double-click  Install-Noctura.bat
2. Approve the administrator prompt (it copies the screen saver into Windows).
3. The Screen Saver settings window opens — choose "Noctura" from the dropdown.
4. Click "Settings..." to pick a scene, colors, clock, and performance mode.

SmartScreen may warn because the build is unsigned: click "More info" then
"Run anyway".


UNINSTALL
---------
Double-click  Uninstall-Noctura.bat  and approve the administrator prompt.
It removes Noctura from Windows. If Noctura was your active screen saver,
open Screen Saver settings and pick a different one.


MANUAL INSTALL (optional)
-------------------------
Right-click the .scr that matches your CPU and choose "Install", or copy it to
C:\Windows\System32\ and select it in Screen Saver settings.
