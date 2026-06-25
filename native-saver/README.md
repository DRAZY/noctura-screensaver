# Noctura — native macOS screensaver (`.saver`)

A true macOS screen saver bundle that renders the same aurora as the Tauri app,
but as a native **Metal** `ScreenSaverView` that installs into **System Settings
→ Screen Saver** and runs like any popular third-party saver (Aerial, Brooklyn,
etc.).

This is distinct from the Tauri `.app` in the parent folder: the `.app` is a
standalone window; this `.saver` is a system screensaver module.

## Why Metal + runtime shader compilation

The scene shaders are written in Metal Shading Language (MSL) and compiled **at
runtime** via `MTLDevice.makeLibrary(source:)`. This is deliberate: the offline
`metal`/`metallib` compilers ship only with full Xcode, not the Command Line
Tools. Runtime compilation needs neither, so the whole bundle builds with just
`swiftc`. `Sources/AuroraShader.swift` is a faithful port of the WebGL gallery
and is kept **at full parity with the Tauri app**: a single fragment entry point
branches on `u.scene` to render all **13 scenes** in the same gallery order —
Aurora Drift, Northern Lights, Deep Space, Particle Drift, Plasma Field, Matrix
Rain, Fireflies, Black Hole, Hyperspace Tunnel, Synthwave, Kaleidoscope, Caustics,
Polar Clock — across the same **13 color themes**. Matrix Rain uses an encoded 5×7
katakana bitmap font, rendered fine and `fwidth`-anti-aliased and scaled by a new
**Size** control (which also drives Fireflies and Caustics); Caustics traces the
F2−F1 Worley border network for true thin light filaments; Northern Lights uses
nimitz-style triangle-noise curtains;
Black Hole and Tunnel sample angular noise on a circle (cos/sin) so there is no
`atan` branch-cut seam; and the final color is dithered to remove 8-bit
banding — identical to the web build.

## Build

```bash
./build.sh            # builds build/Noctura.saver
./build.sh --install  # also copies to ~/Library/Screen Savers/
```

The build runs three gates:

1. **shader-check** — compiles the MSL + render pipeline on the real GPU
   headlessly. Fails the build if the shader is invalid.
2. **swiftc** — compiles the Swift sources into the bundle's Mach-O executable.
3. **assemble + ad-hoc sign** — lays out `Noctura.saver/Contents/...` and signs
   it so Gatekeeper loads it locally without a Developer ID.

`verify-load.swift` is an extra harness that loads the finished bundle the way
macOS does (`NSBundle` → `principalClass` → instantiate) to catch principal-class
and init failures before you ever open System Settings.

## Install

```bash
# Either use the build flag:
./build.sh --install

# …or copy manually:
cp -R build/Noctura.saver ~/Library/Screen\ Savers/
```

Then open **System Settings → Screen Saver**, pick **Noctura**, and click
**Options…** to configure it. (If System Settings was already open, quit and
reopen it so it rescans `~/Library/Screen Savers/`.)

## Customization (Options sheet)

Matches what mature screensavers expose, persisted via `ScreenSaverDefaults`:

| Control     | Range / values                                                    |
|-------------|-------------------------------------------------------------------|
| Scene       | Any of the 13 gallery scenes                                      |
| Style       | 13 palettes (Aurora · Borealis · Ocean · Synthwave · Monochrome…) |
| Speed       | 0.03 – 1.2 (flow rate)                                            |
| Intensity   | 0.0 – 1.5 (brightness / contrast lift)                            |
| Density     | 0.0 – 1.0 (element count / fill)                                  |
| Size        | 0.4 – 2.2 (element scale — Matrix glyphs, Fireflies, Caustics)    |
| Performance | **Auto (adaptive)** · Full (60 fps, native) · Balanced (60 fps, 1.5×) · Power Saver (30 fps, 1×) |

**Performance** is the GPU-headroom control, and it's why this saver runs the
same on a 2014 dual-core laptop and an M-series desktop. A full-screen procedural
shader pays for every *physical* pixel, so on a Retina/4K/5K panel native
resolution is the dominant cost.

- **Auto (adaptive)** — the default. Each frame it reads the real GPU execution
  time (`gpuEndTime − gpuStartTime`) and continuously trims render resolution
  (then frame rate, as a last resort) to stay comfortably inside the frame
  budget, climbing back toward native when there's headroom. No tuning, no
  knowledge of your GPU required — it converges to whatever the hardware can
  sustain. On GPUs that don't report timestamps it falls back to detecting
  dropped frames and only ever reduces load. A hard resolution backstop
  (longest edge ≤ 5120 px) protects 6K/8K and spanned displays in every mode.
- **Full** — pins native-resolution 60 fps (the richest look; for strong GPUs).
- **Balanced** — 1.5× backing scale (~44% fewer pixels), 60 fps.
- **Power Saver** — 1× scale, 30 fps (~⅛ the GPU work); for the weakest hardware.

All four upscale the rendered image to fill the display, so lower modes look
softer but never letterboxed or wrong.

> Scene cost varies widely — measure with `swiftc -O -parse-as-library -framework
> Metal -o /tmp/gtc Sources/AuroraShader.swift Sources/Preferences.swift
> gpu-time-check.swift && /tmp/gtc 5120 2880`. It prints per-scene GPU time so you
> can see what Auto is reacting to.

Settings survive across sessions and are shared between the preview thumbnail
and the live saver.

## Files

| File                         | Role                                               |
|------------------------------|----------------------------------------------------|
| `Sources/AuroraShader.swift` | MSL source + `AuroraUniforms` (CPU/GPU mirror)     |
| `Sources/AuroraRenderer.swift`| Metal device, pipeline, per-frame draw            |
| `Sources/AuroraView.swift`   | `ScreenSaverView` subclass + Options sheet         |
| `Sources/Preferences.swift`  | Palettes + `ScreenSaverDefaults` persistence       |
| `Info.plist`                 | Bundle metadata, `NSPrincipalClass = AuroraView`   |
| `build.sh`                   | Build + optional `--install`                       |
| `shader-check.swift`         | Headless GPU pipeline-compile gate                 |
| `verify-load.swift`          | Headless bundle-load / instantiate gate            |

## Notes & limits

- **Apple Silicon (arm64)** build. Add `-target x86_64-apple-macos13.0` and
  `lipo` the two slices for a universal bundle if you need Intel.
- Ad-hoc signed for **local** use. Distributing to other Macs needs a Developer
  ID signature + notarization.
- Visual output can only be confirmed by selecting it in System Settings — the
  build/load gates verify everything else headlessly.
