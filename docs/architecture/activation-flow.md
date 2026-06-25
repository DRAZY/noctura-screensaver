---
type: reference
tags: [screensaver, macos, activation]
---

# Activation Flow

How Aurora becomes an actual screensaver — versus just a fullscreen player.

## Native saver (recommended path)

The installed `Aurora.saver` delegates activation entirely to macOS, which is the
correct, robust design — no custom idle loop to get wrong:

```
macOS idle timer (System Settings → Lock Screen → "Start Screen Saver when inactive")
        │  user idle ≥ threshold
        ▼
legacyScreenSaver host loads Aurora.saver → AuroraView.startAnimation()
        │  animateOneFrame() @ 60Hz  (Metal draw)
        ▼
any input (key / mouse / trackpad)  →  macOS tears the view down → desktop
```

Multi-monitor, lock-screen integration, preview thumbnails, and
input-to-dismiss are all provided by the OS for `.saver` modules. This is why the
native saver, not the Tauri app, is the real screensaver.

Configuration (scene, palette, speed, intensity, density) is read from
`ScreenSaverDefaults` at `startAnimation()` and editable via the Options sheet
(`AuroraView.configureSheet`).

## Tauri app (player / gallery)

The app is the interactive gallery and configurator. It runs the same visuals
fullscreen and dismisses on `Esc` (closing the panel first if open). It is not
intended as the background idle-activated screensaver — that role belongs to the
installed `.saver`, so idle detection is not duplicated in the app layer.

See [[System-Overview]] for the component breakdown and [[Scene-Contract]] for
adding scenes.
