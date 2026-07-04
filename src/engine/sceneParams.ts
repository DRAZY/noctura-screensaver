import type { Parameter } from "./types";
import { PALETTE_OPTIONS } from "./palette";

/**
 * Shared, native-parity control model for every scene.
 *
 * The native `.saver`/`.scr` builds expose ONE global control set — Speed,
 * Intensity, Density, Size, Style — shared across all scenes, with fixed ranges
 * and defaults (see macOS `AuroraPreferences` and Windows `settings.rs`). To keep
 * the web app in parity, every scene declares exactly these five controls via
 * {@link NATIVE_PARAMETERS} and maps them onto its own uniforms.
 *
 * As on native, not every scene responds to every knob — a scene simply ignores
 * the ones its shader has no use for (native's per-scene shaders do the same).
 */

/** Native default knob positions (mirror the native persisted defaults). */
export const NATIVE_DEFAULTS = {
  speed: 0.3,
  intensity: 1.0,
  density: 0.5,
  size: 0.85,
} as const;

/** Native default palette (index 0 = Aurora). */
export const NATIVE_STYLE_DEFAULT = "aurora";

/** The five native controls, identical ranges/defaults across all scenes. */
export const NATIVE_PARAMETERS: ReadonlyArray<Parameter> = [
  { kind: "range", id: "speed", label: "Speed", min: 0.03, max: 1.2, step: 0.01, default: NATIVE_DEFAULTS.speed },
  { kind: "range", id: "intensity", label: "Intensity", min: 0.0, max: 1.5, step: 0.01, default: NATIVE_DEFAULTS.intensity },
  { kind: "range", id: "density", label: "Density", min: 0.0, max: 1.0, step: 0.01, default: NATIVE_DEFAULTS.density },
  { kind: "range", id: "size", label: "Size", min: 0.4, max: 2.2, step: 0.01, default: NATIVE_DEFAULTS.size },
  { kind: "select", id: "theme", label: "Style", options: PALETTE_OPTIONS, default: NATIVE_STYLE_DEFAULT },
];

/**
 * Proportional remap of a native knob onto a scene's uniform, anchored on that
 * uniform's original default `base`: when the knob sits at its native default the
 * uniform equals `base` (so the scene's hand-tuned look is preserved), and it
 * scales linearly from there. This lets the shared 0.4–2.2 Size slider (etc.)
 * drive a uniform that was authored in a completely different numeric range.
 */
export const remapSpeed = (v: number, base: number): number => base * (v / NATIVE_DEFAULTS.speed);
export const remapIntensity = (v: number, base: number): number => base * (v / NATIVE_DEFAULTS.intensity);
export const remapDensity = (v: number, base: number): number => base * (v / NATIVE_DEFAULTS.density);
export const remapSize = (v: number, base: number): number => base * (v / NATIVE_DEFAULTS.size);
