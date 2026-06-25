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

FRAMEWORKS=(-framework ScreenSaver -framework AppKit -framework Metal -framework MetalKit -framework QuartzCore)

echo "==> Cleaning $BUILD"
rm -rf "$BUILD"
mkdir -p "$SAVER/Contents/MacOS"

echo "==> [1/3] Headless shader-check (compile MSL + pipeline on GPU)"
swiftc -O -target "$TARGET" -framework Metal \
    -o "$BUILD/shader-check" \
    "$DIR/Sources/AuroraShader.swift" "$DIR/shader-check.swift"
"$BUILD/shader-check"

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

if [[ "${1:-}" == "--install" ]]; then
    DEST="$HOME/Library/Screen Savers"
    mkdir -p "$DEST"
    rm -rf "$DEST/Noctura.saver"
    cp -R "$SAVER" "$DEST/Noctura.saver"
    echo "==> Installed to $DEST/Noctura.saver"
fi
