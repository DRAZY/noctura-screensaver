import * as THREE from "three";

/**
 * Named color palettes shared across scenes so the "Theme" select means the
 * same thing everywhere. Each palette is three stops (a → b → c) that scenes
 * map onto their gradients, particle tints, nebulae, ribbons, etc.
 */
export interface Palette {
  readonly id: string;
  readonly label: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
}

/** The shipped themes, in display order. `aurora` is the signature default. */
export const PALETTES: readonly Palette[] = [
  { id: "aurora", label: "Aurora", a: "#1a1240", b: "#c81e8a", c: "#f5a623" },
  { id: "borealis", label: "Borealis", a: "#051721", b: "#13c285", c: "#9ef26b" },
  { id: "deepspace", label: "Deep Space", a: "#02030a", b: "#3a2f8f", c: "#cfe0ff" },
  { id: "ocean", label: "Ocean", a: "#030e2e", b: "#0c5ca3", c: "#6bd2e0" },
  { id: "ember", label: "Ember", a: "#1c0503", b: "#c73b0a", c: "#fad043" },
  { id: "synthwave", label: "Synthwave", a: "#170230", b: "#d91c8f", c: "#2ec2eb" },
  { id: "sunset", label: "Sunset", a: "#241023", b: "#e85a6b", c: "#ffce6b" },
  { id: "nebula", label: "Nebula", a: "#0a0418", b: "#7b2ff7", c: "#f76fd4" },
  { id: "mint", label: "Mint", a: "#04140f", b: "#1fb892", c: "#c9ffe8" },
  { id: "gold", label: "Gold", a: "#140d02", b: "#b07d1a", c: "#ffe9a8" },
  { id: "ice", label: "Ice", a: "#040a14", b: "#3b6fae", c: "#e9f6ff" },
  { id: "rose", label: "Rose", a: "#1c0610", b: "#d6336c", c: "#ffd9c2" },
  { id: "mono", label: "Monochrome", a: "#050506", b: "#616670", c: "#eaeff5" },
] as const;

/** Options array ready to drop into a `SelectParameter`. */
export const PALETTE_OPTIONS = PALETTES.map((p) => ({ value: p.id, label: p.label }));

const PALETTE_BY_ID = new Map(PALETTES.map((p) => [p.id, p]));

/** Look up a palette by id, falling back to the first (aurora) if unknown. */
export function paletteById(id: string): Palette {
  return PALETTE_BY_ID.get(id) ?? PALETTES[0];
}

/** Parse a CSS hex string into a `THREE.Color` (sRGB). */
export function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(hex);
}

/** Parse a CSS hex string into a `THREE.Vector3` of linear-ish [0,1] rgb. */
export function hexToVec3(hex: string): THREE.Vector3 {
  const c = new THREE.Color(hex);
  return new THREE.Vector3(c.r, c.g, c.b);
}
