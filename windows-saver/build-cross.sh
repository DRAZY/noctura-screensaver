#!/usr/bin/env bash
# Cross-compile the Noctura Windows screensaver from macOS/Linux.
#
# Produces native Windows .scr binaries for x64 and ARM64 without a Windows
# machine, using cargo-xwin (downloads the MSVC CRT + Windows SDK headers and
# links with rust-lld). The output is a real PE32+ GUI executable.
#
# One-time setup:
#   cargo install --locked cargo-xwin
#   rustup target add x86_64-pc-windows-msvc aarch64-pc-windows-msvc
#
# Usage: ./build-cross.sh
set -euo pipefail
cd "$(dirname "$0")"

export XWIN_ACCEPT_LICENSE=1
OUT="../dist/windows"
mkdir -p "$OUT"

for triple in x86_64-pc-windows-msvc aarch64-pc-windows-msvc; do
    echo "==> Building $triple"
    cargo xwin build --release --target "$triple"
done

cp target/x86_64-pc-windows-msvc/release/noctura.exe  "$OUT/Noctura-x64.scr"
cp target/x86_64-pc-windows-msvc/release/noctura.exe  "$OUT/Noctura-x64.exe"
cp target/aarch64-pc-windows-msvc/release/noctura.exe "$OUT/Noctura-arm64.scr"
cp target/aarch64-pc-windows-msvc/release/noctura.exe "$OUT/Noctura-arm64.exe"

echo "==> Done. Artifacts in $OUT:"
ls -lh "$OUT"
