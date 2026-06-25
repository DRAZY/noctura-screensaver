# Noctura

A cross-platform animated screensaver with a **gallery of GPU scenes**, built on
Tauri + React + TypeScript + Three.js/WebGL. Ships in two forms:

1. **Noctura app** (`.app`/`.dmg`) — the full interactive gallery: browse scenes,
   tune them live, settings persist. The place to explore and configure.
2. **Noctura.saver** — a native macOS Metal screensaver module that installs into
   **System Settings → Screen Saver** and is driven by macOS itself (idle
   activation, multi-monitor, and input-to-dismiss are handled by the OS).

## Scenes

| Scene | Look | Reference |
|-------|------|-----------|
| Aurora Drift | Domain-warped flowing color fields | Aeon / Drift |
| Northern Lights | Swaying translucent aurora curtains | macOS XDR / Aerial |
| Deep Space | Parallax stars + drifting nebula | Aerial Deep Space |
| Particle Drift | Luminous curl-noise particle flow | Drift |
| Plasma Field | Liquid demoscene color waves | Plasma |
| Matrix Rain | Cascading digital glyph rain | The Matrix |
| Fireflies | Drifting glowing swarm in the dark | Ambient |
| Black Hole | Swirling accretion disk + photon ring | Interstellar |
| Hyperspace Tunnel | Endless light tunnel with speed-streaks | Hyperspace |
| Synthwave | Neon outrun grid + banded retro sun | Outrun / 80s |
| Kaleidoscope | Living mirrored color mandala | Kaleidoscope |
| Caustics | Rippling pool-light webs over deep water | Sunlit water |
| Polar Clock | Concentric live time arcs | Polar Clock |

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
