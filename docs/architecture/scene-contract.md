---
type: reference
tags: [tauri, webgl, three-js, scenes]
---

# Scene Contract

A scene is any class implementing `Scene` from `src/engine/types.ts`. The
`SceneManager` and the settings UI depend only on this interface, so adding a
scene is purely additive.

## The interface

```ts
interface Scene {
  readonly id: string;            // stable id (persistence + registry)
  readonly name: string;          // shown in the picker
  readonly description: string;   // shown in the picker
  readonly parameters: ReadonlyArray<Parameter>;  // drives the controls UI

  init(ctx: SceneContext): void;  // allocate GPU resources, build scene graph
  update(time: number, delta: number): void;      // advance animation
  render(renderer, target): void; // draw to screen (null) or offscreen target
  resize(width: number, height: number): void;
  setParameter(id: string, value: ParameterValue): void;  // live, no rebuild
  dispose(): void;                // release everything
}
```

`Parameter` is a discriminated union: `range` (slider), `color` (color well),
`select` (segmented control). Declaring parameters is all the UI needs — controls
render automatically.

## Two ways to build one

- **Fullscreen shader scene** — extend `FullscreenScene` (scenes/FullscreenScene.ts).
  You only implement `createMaterial()` (a `ShaderMaterial` with `uTime`/
  `uResolution` uniforms) and `setParameter()`. Used by Aurora Drift, Northern
  Lights, Deep Space.
- **Custom scene** — implement `Scene` directly when you need a different camera
  or primitives (Particle Drift uses a `Points` cloud + perspective camera; Polar
  Clock reads live time each frame).

## Steps to add a scene

1. Create `src/scenes/MyScene.ts` implementing `Scene` (or extending `FullscreenScene`).
2. Reuse `engine/shaders/noise.glsl.ts` and `engine/palette.ts` for consistency.
3. Register it in `src/scenes/index.ts` (`manager.register(new MyScene())`).

That's it — it appears in the gallery picker, its controls render from its
`parameters`, and its overrides persist automatically.

## Porting a scene to the native saver

Add a fragment function to `native-saver/Sources/AuroraShader.swift`, branch to
it on a new `scene` index in `aurora_fragment`, and add the name to
`AuroraScene.all` in `Preferences.swift`.
