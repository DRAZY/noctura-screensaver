#!/usr/bin/env bash
# Build Noctura.pkg — a real macOS installer for the screensaver.
#
# Native install wizard, installs to /Library/Screen Savers (all users), and
# the postinstall cleans up ORPHANS: any per-user copy in ~/Library/Screen
# Savers from older zip-based installs, plus stale legacyScreenSaver hosts
# that keep running an old version until logout. Usage:
#   ./build-pkg.sh <version> [outDir]   (expects ../build/Noctura.saver built)
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:?usage: build-pkg.sh <version> [outDir]}"
OUT="${2:-.}"
SAVER="../build/Noctura.saver"
[ -d "$SAVER" ] || { echo "ERROR: $SAVER not built (run ../build.sh first)"; exit 1; }

STAGE="$(mktemp -d)"
SCRIPTS="$(mktemp -d)"
trap 'rm -rf "$STAGE" "$SCRIPTS"' EXIT
cp -R "$SAVER" "$STAGE/"

cat > "$SCRIPTS/postinstall" << 'POST'
#!/bin/bash
# Orphan cleanup: remove per-user copies superseded by this system-wide install
# so the Screen Saver list never shows two Nocturas, and kill cached saver
# hosts so the new version is picked up without logging out.
CONSOLE_USER="$(stat -f%Su /dev/console 2>/dev/null || true)"
if [ -n "$CONSOLE_USER" ] && [ "$CONSOLE_USER" != "root" ]; then
    USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
    if [ -n "$USER_HOME" ] && [ -d "$USER_HOME/Library/Screen Savers/Noctura.saver" ]; then
        rm -rf "$USER_HOME/Library/Screen Savers/Noctura.saver"
    fi
fi
killall -9 legacyScreenSaver 2>/dev/null || true
killall -9 legacyScreenSaver-x86_64 2>/dev/null || true
exit 0
POST
chmod +x "$SCRIPTS/postinstall"

COMPONENT="$STAGE/component.pkg"
pkgbuild \
  --identifier com.aurora.screensaver.pkg \
  --version "$VERSION" \
  --install-location "/Library/Screen Savers" \
  --scripts "$SCRIPTS" \
  --component "$STAGE/Noctura.saver" \
  "$COMPONENT"

# Wrap in a product archive so Installer.app shows a proper title page.
DIST="$STAGE/distribution.xml"
cat > "$DIST" << XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
    <title>Noctura Screen Saver</title>
    <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
    <choices-outline><line choice="default"/></choices-outline>
    <choice id="default" title="Noctura"><pkg-ref id="com.aurora.screensaver.pkg"/></choice>
    <pkg-ref id="com.aurora.screensaver.pkg" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
XML
productbuild \
  --distribution "$DIST" \
  --package-path "$STAGE" \
  "$OUT/Noctura-$VERSION.pkg"
echo "==> Built $OUT/Noctura-$VERSION.pkg"
