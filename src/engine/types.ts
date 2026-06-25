import type * as THREE from "three";

/**
 * The screensaver's scene engine contract. Every visual ("scene") implements
 * {@link Scene}: it owns its own Three.js scene graph + camera, advances itself
 * each frame, and declares its tunable {@link Parameter}s so the settings UI can
 * render controls automatically — no per-scene UI code.
 */

/** A value a {@link Parameter} can hold. Numbers for ranges, strings for colors/selects. */
export type ParameterValue = number | string;

/**
 * Render-cost profile, mirroring the native `.saver`'s Performance control.
 * `auto` adapts render resolution (and, as a last resort, frame rate) to the
 * measured frame time so it stays smooth on any GPU; the fixed modes are manual
 * overrides from richest (`full`) to lightest (`power`).
 */
export type PerformanceMode = "auto" | "full" | "balanced" | "power";

/** A continuous numeric control (speed, density, glow…). Rendered as a slider. */
export interface RangeParameter {
  readonly kind: "range";
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly default: number;
}

/** A color control (hex string, e.g. `#1a1240`). Rendered as a color well. */
export interface ColorParameter {
  readonly kind: "color";
  readonly id: string;
  readonly label: string;
  readonly default: string;
}

/** A discrete choice (theme/preset, on/off). Rendered as a segmented control. */
export interface SelectParameter {
  readonly kind: "select";
  readonly id: string;
  readonly label: string;
  readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly default: string;
}

export type Parameter = RangeParameter | ColorParameter | SelectParameter;

/** Construction context handed to a scene's `init` — the live renderer + viewport. */
export interface SceneContext {
  readonly renderer: THREE.WebGLRenderer;
  readonly width: number;
  readonly height: number;
}

/**
 * A renderable screensaver visual. Scenes are self-contained: they create their
 * own `THREE.Scene`/camera in `init`, draw themselves in `render` (to the screen
 * or to an offscreen target so the manager can crossfade), and release
 * everything in `dispose`.
 */
export interface Scene {
  /** Stable identifier used for persistence + the registry. */
  readonly id: string;
  /** Human-readable name shown in the picker. */
  readonly name: string;
  /** One-line description shown in the picker. */
  readonly description: string;
  /** Declarative list of tunable controls; drives the settings UI. */
  readonly parameters: ReadonlyArray<Parameter>;

  /** Allocate GPU resources and build the scene graph. Called once. */
  init(ctx: SceneContext): void;
  /** Advance animation. `time` = seconds since scene start, `delta` = seconds since last frame. */
  update(time: number, delta: number): void;
  /**
   * Draw one frame. `target` is null to draw to the screen, or an offscreen
   * render target during crossfades. Scenes must honor it via
   * `renderer.setRenderTarget(target)`.
   */
  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void;
  /** React to viewport size changes (update aspect, resolution uniforms, etc.). */
  resize(width: number, height: number): void;
  /** Apply a parameter change live (no rebuild). Unknown ids are ignored. */
  setParameter(id: string, value: ParameterValue): void;
  /** Release all GPU + scene resources. */
  dispose(): void;
}

/** Look up a parameter's declared default by id — used to seed/reset settings. */
export function defaultsFor(scene: Scene): Record<string, ParameterValue> {
  const out: Record<string, ParameterValue> = {};
  for (const p of scene.parameters) out[p.id] = p.default;
  return out;
}
