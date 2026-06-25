---
type: reference
tags: [tauri, webgl, screensaver, metal, three-js]
---

# System Overview

Aurora is two rendering front-ends over one shared visual design:

- **Web/WebGL gallery** (the Tauri app) — `Three.js` scenes driven by a
  `SceneManager`, configured through a React settings panel.
- **Native Metal saver** (`Aurora.saver`) — the same scenes ported to Metal
  Shading Language, hosted by a `ScreenSaverView` and run by macOS.

## Web app architecture

```
App.tsx
 ├─ SceneManager (engine/SceneManager.ts)
 │   ├─ owns THREE.WebGLRenderer + RAF loop
 │   ├─ register() / list() / setActive() / cycle()
 │   ├─ 800ms render-target crossfade between scenes
 │   └─ Scene[] (scenes/*.ts) implementing the Scene contract
 ├─ SettingsPanel (ui/*) — gallery picker + auto-generated param controls
 └─ state/settings.ts — localStorage persistence
```

Every scene implements `Scene` (`engine/types.ts`): it owns its own
`THREE.Scene` + camera, advances itself in `update`, draws in `render` (to the
screen or an offscreen target for crossfades), and declares its tunable
`Parameter`s so the settings UI renders controls with zero per-scene code.

Shared GLSL (`engine/shaders/noise.glsl.ts`) and palettes (`engine/palette.ts`)
keep the scenes consistent and DRY.

See [[Scene-Contract]] for how a scene plugs in, and [[Activation-Flow]] for how
the native saver is activated by the OS.

## Native saver architecture

```
AuroraView (ScreenSaverView)   ← NSPrincipalClass, macOS drives it
 ├─ AuroraRenderer              ← Metal device, pipeline, per-frame draw
 │   └─ AuroraShaderSource.metal (runtime-compiled multi-scene MSL)
 ├─ AuroraPreferences           ← ScreenSaverDefaults (scene/palette/speed/…)
 └─ AuroraConfigController      ← programmatic Options sheet
```

The MSL is compiled at runtime (`makeLibrary(source:)`) because the offline
`metal` compiler ships only with full Xcode. A single fragment entry point
branches on a `scene` uniform to render one of the five scenes.

## Why two front-ends

A `.saver` integrates with macOS (idle activation, multi-monitor, lock-screen,
input-to-dismiss — all free). A Tauri app gives a rich interactive gallery and a
cross-platform (Windows) path. They share the design language and palettes, not
code, because WebGL and Metal are different runtimes.
