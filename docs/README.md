# Noctura

A cross-platform animated screensaver with a **gallery of GPU scenes**, built on
Tauri + React + TypeScript + Three.js/WebGL. Ships in three forms:

1. **Noctura app** (`.app`/`.dmg`) — the full interactive gallery: browse scenes,
   tune them live, settings persist. The place to explore and configure.
2. **Noctura.saver** — a native macOS Metal screensaver module that installs into
   **System Settings → Screen Saver** and is driven by macOS itself (idle
   activation, multi-monitor, and input-to-dismiss are handled by the OS).
3. **Noctura.scr** — a native Windows Direct3D 11 screensaver (`windows-saver/`),
   a single ~400 KB executable with no runtime to install, cross-compiled from
   macOS via cargo-xwin.

## Scenes

| Scene | Look | Reference |
|-------|------|-----------|
| **Flux Drift** | Real fluid-sim blades combed around living vortices | Faithful port of [Flux](https://github.com/sandydoo/flux) (macOS Drift) |
| Aurora Drift | Domain-warped flowing color fields | Aeon / Drift |
| Northern Lights | Swaying translucent aurora curtains | macOS XDR / Aerial |
| Nebula Drift | Slow volumetric nebula clouds | Deep-sky photography |
| Fractal Bloom | Unfolding kaleidoscopic fractal petals | Fractal art |
| Liquid Chrome | Molten reflective metal waves | T2 / chrome |
| Deep Space | Parallax stars + drifting nebula | Aerial Deep Space |
| Particle Drift | Luminous curl-noise particle flow | Drift |
| Particle Swarm | 60k-point 3D murmuration | Starling flocks |
| Plasma Field | Liquid demoscene color waves | Plasma |
| Matrix Rain | Cascading digital glyph rain | The Matrix |
| Fireflies | Drifting glowing swarm in the dark | Ambient |
| Black Hole | Swirling accretion disk + photon ring | Interstellar |
| Hyperspace Tunnel | Endless light tunnel with speed-streaks | Hyperspace |
| Synthwave | Neon outrun grid + banded retro sun | Outrun / 80s |
| Kaleidoscope | Living mirrored color mandala | Kaleidoscope |
| Caustics | Rippling pool-light webs over deep water | Sunlit water |
| Polar Clock | Concentric live time arcs | Polar Clock |

**Flux Drift** is not a fragment-shader effect like the others — it's a faithful
multi-pass port of the Flux source, identical on all three renderers: a 128²
Stam Stable-Fluids solver stepped at a fixed real-time 60 Hz (MacCormack
advection, viscous diffusion, 19-iteration pressure projection, simplex-noise
forcing with per-channel drift/breathing/crossfade), a screen-adaptive line grid
(one blade per 15 logical px), per-line damped-spring physics with 12 floats of
persistent state (endpoint, spring velocity, color, color velocity, width — the
color itself is a spring chasing a velocity-derived target), a rounded-endpoint
pass using Flux's blend-compensation trick, and linear-space (SRC_ALPHA, ONE)
accumulation with a final sRGB encode. Verified against https://flux.sandydoo.me/
with side-by-side captures and motion-decorrelation measurement
(`scripts/capture-drift.ts` — real-clock captures; Chrome's virtual-time mode
starves real-time simulations and must not be used to verify this scene).

Matrix Rain uses a real encoded 5×7 katakana bitmap font, rendered fine and small
with a **Glyph Size** control; Caustics traces the F2−F1 Worley border network for
true thin light filaments; Northern Lights uses nimitz-style triangle-noise
curtains; Kaleidoscope, Caustics, Polar Clock, Synthwave and the grid lines use
`fwidth` anti-aliasing for resolution-independent crispness with no tearing.

Every scene exposes live-tunable parameters (speed, color theme, density, **size**, …)
that the settings UI renders automatically from each scene's declared `parameters`.
Matrix Rain, Fireflies, Particle Drift and Caustics add a **Size** control to scale
their elements. An **About** card in the settings panel credits the creator.

## Playback & overlays

- **Slideshow** — auto-advance through the gallery on a timer (5–300s), in random
  or sequential order. Toggle with the panel switch or the <kbd>Space</kbd> key.
- **Favorites** — star scenes (☆/★ on each card); restrict the slideshow to
  favorites only.
- **Clock overlay** — optional time, or time + date, drawn crisply over any scene
  (Fliqlo/Aerial style). Preview via `?clock=time` or `?clock=datetime`.
- **Performance** — GPU-cost profile, at parity with the native saver. **Auto**
  (default) measures the display-refresh cadence and adapts render resolution —
  then frame rate (60→30) as a last resort — to stay smooth on any GPU, climbing
  back toward native when there's headroom. **Full / Balanced / Saver** are manual
  overrides (native resolution 60 fps → quarter resolution 30 fps).

All preferences persist in `localStorage` alongside per-scene parameter overrides.

## Run the app (dev)

```bash
source "$HOME/.cargo/env"      # Rust on PATH (one-time per shell)
bun install
bun run tauri dev
```

Keys: `S` gallery/settings · `N`/`P` next/prev scene · `Space` toggle slideshow ·
`Esc` close panel, then quit.
Deep-link a scene for previews: `http://localhost:1420/?scene=black-hole&panel=1`
(append `&clock=datetime` to preview the clock overlay).

## Build the app (macOS)

```bash
bun run tauri build
# → src-tauri/target/release/bundle/macos/Noctura.app
# → src-tauri/target/release/bundle/dmg/Noctura_<ver>_aarch64.dmg
```

Universal/Intel: add `--target universal-apple-darwin` (requires both Rust targets).

## Build the app (Windows — from the same codebase)

Tauri produces Windows installers from this identical project on a Windows host
with the MSVC toolchain + Rust + Bun:

```powershell
bun install
bun run tauri build
# → src-tauri\target\release\bundle\nsis\Noctura_<ver>_x64-setup.exe
# → src-tauri\target\release\bundle\msi\Noctura_<ver>_x64_en-US.msi
```

The NSIS and MSI targets are configured in `src-tauri/tauri.conf.json`
(`bundle.targets`). No code changes are needed — the WebGL scenes run identically
on the Windows WebView2 runtime.

## Install the native screensaver (macOS)

```bash
cd native-saver
./build.sh --install          # builds Noctura.saver and copies to ~/Library/Screen Savers
```

Then **System Settings → Screen Saver → Noctura → Options…** to pick the scene,
palette, speed, intensity, and density. (Quit/reopen System Settings if it was
already open.) See `native-saver/README.md` for details.

## Adding a scene

Implement the `Scene` contract and register it — that's all. See
[`docs/architecture/scene-contract.md`](architecture/scene-contract.md).

## Settings

The app persists the active scene and per-scene parameter overrides to
`localStorage` (`aurora.settings.v1`). The native saver persists scene, palette,
speed, intensity, and density via `ScreenSaverDefaults`.
