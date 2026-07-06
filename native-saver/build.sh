#!/bin/bash
# Build Noctura.saver — a native macOS screensaver bundle — using only the
# Command Line Tools (no Xcode required). The Metal shader is compiled at
# runtime inside the app, so the offline `metal`/`metallib` tools are not needed.
#
# Steps:
#   1. Headless shader-check: compile the MSL + render pipeline on the real GPU.
#   2. Compile the Swift sources into the bundle's Mach-O executable.
#   3. Assemble Noctura.saver/Contents/{Info.plist,MacOS/Noctura}.
#
# Usage: ./build.sh [--install]
#   --install also copies the result to ~/Library/Screen Savers/.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD="$DIR/build"
SAVER="$BUILD/Noctura.saver"
SOURCES=("$DIR"/Sources/*.swift)
TARGET="arm64-apple-macos13.0"

FRAMEWORKS=(-framework ScreenSaver -framework AppKit -framework Metal -framework MetalKit -framework QuartzCore -framework IOKit)

echo "==> Cleaning $BUILD"
rm -rf "$BUILD"
mkdir -p "$SAVER/Contents/MacOS"

echo "==> [1/3] Headless shader-check (compile MSL + pipeline on GPU)"
swiftc -O -target "$TARGET" -framework Metal -framework QuartzCore \
    -o "$BUILD/shader-check" \
    "$DIR/Sources/AuroraShader.swift" "$DIR/Sources/AuroraFluxFluid.swift" \
    "$DIR/Sources/AuroraParticleSwarm.swift" "$DIR/shader-check.swift"
"$BUILD/shader-check"

# GPU-cost gate: measure every scene's real per-frame GPU time and FAIL the build
# if any scene is catastrophically expensive (the guard that would have caught the
# 605 ms/frame Flux Drift before it ever shipped and froze a machine).
echo "==> GPU-cost gate (per-scene frame time ceiling)"
swiftc -O -target "$TARGET" -framework Metal \
    -o "$BUILD/gpu-time-check" \
    "$DIR/Sources/AuroraShader.swift" "$DIR/Sources/Preferences.swift" "$DIR/gpu-time-check.swift"
"$BUILD/gpu-time-check"

echo "==> [2/3] Compiling Swift sources into bundle executable"
swiftc -O \
    -target "$TARGET" \
    -module-name Aurora \
    -emit-library \
    "${FRAMEWORKS[@]}" \
    -o "$SAVER/Contents/MacOS/Noctura" \
    "${SOURCES[@]}"

echo "==> [3/3] Assembling bundle"
cp "$DIR/Info.plist" "$SAVER/Contents/Info.plist"
# Mach-O type check: the executable must be loadable by the screensaver host.
file "$SAVER/Contents/MacOS/Noctura"

# Ad-hoc codesign so Gatekeeper lets the local user load it without a Dev ID.
if command -v codesign >/dev/null 2>&1; then
    echo "==> Ad-hoc signing"
    codesign --force --deep --sign - "$SAVER" || echo "   (codesign skipped/failed — local load still works)"
fi

echo "==> Built: $SAVER"

# Load-check: instantiate the bundle exactly as the screensaver host does and
# exercise the Options-sheet path (preview instance vends a populated
# configureSheet twice). Catches init crashes, a broken principal class, and the
# "Options button does nothing" regression before the bundle ever ships.
echo "==> Load-check (instantiate + Options sheet)"
swiftc -O -parse-as-library -target "$TARGET" -framework AppKit -framework ScreenSaver \
    -o "$BUILD/verify-load" "$DIR/verify-load.swift"
"$BUILD/verify-load" "$SAVER"

# Kill the caching host + Settings so a reinstall actually loads the new bundle.
# macOS's legacyScreenSaver keeps the old bundle in memory across a file replace,
# which is the classic "I reinstalled but still see the old version" trap.
kill_saver_hosts() {
    osascript -e 'tell application "System Settings" to quit' 2>/dev/null || true
    osascript -e 'tell application "System Preferences" to quit' 2>/dev/null || true
    killall legacyScreenSaver 2>/dev/null || true
    killall ScreenSaverEngine 2>/dev/null || true
    sleep 1
}

if [[ "${1:-}" == "--install" ]]; then
    DEST="$HOME/Library/Screen Savers"
    kill_saver_hosts
    mkdir -p "$DEST"
    rm -rf "$DEST/Noctura.saver"
    cp -R "$SAVER" "$DEST/Noctura.saver"
    echo "==> Installed to $DEST/Noctura.saver (stale host processes killed)"
elif [[ "${1:-}" == "--uninstall" ]]; then
    DEST="$HOME/Library/Screen Savers/Noctura.saver"
    kill_saver_hosts
    rm -rf "$DEST"
    defaults delete com.aurora.screensaver 2>/dev/null || true
    echo "==> Uninstalled $DEST (and cleared saved settings)"
fi
