import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Drift — an homage to the macOS "Drift" screensaver, informed by its open
 * tribute Flux (github.com/sandydoo/flux). Thousands of short dashes are combed
 * along a slow, divergence-free flow field over big soft regions of palette
 * color — the woven, brushed-fingerprint texture of light streaming around
 * vortices on black.
 *
 * A single fullscreen fragment shader (no particles / no ping-pong) so it ports
 * cleanly to the native Metal / D3D savers. Per pixel it walks the 3×3 grid of
 * neighbouring cells; each cell drops one dash anchored at its (jittered) centre,
 * oriented along the local flow velocity — the curl of a smooth, slowly-evolving
 * scalar potential, kept UN-normalized so its magnitude survives. That magnitude
 * (flow speed) drives each dash's length and brightness, so — exactly like Flux —
 * still water thins to black and fast water combs into long bright strokes. Big
 * palette-cycled colour regions tint the whole field.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpeed;
uniform float uFlow;     // swirl scale (bigger = smaller, tighter vortices)
uniform float uGrid;     // dash density (cells across the field)
uniform float uDash;     // dash length multiplier
uniform float uGlow;     // dash brightness
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform vec3  uSky;      // near-black background

${SIMPLEX_2D}
${DITHER}

// Smooth A->B->C->A cycle so the big color regions braid through all three stops.
vec3 ncCyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// Divergence-free flow velocity at x (curl of a smooth, slowly-evolving scalar
// potential): vel = (dPot/dy, -dPot/dx). Kept UN-normalized so its magnitude
// survives — this is the crux of the Flux look: line LENGTH scales with local
// flow speed, so calm water shows tiny stubs and fast currents draw long streaks.
vec2 driftVel(vec2 x, float t) {
  float e = 0.02;
  vec2 dr = vec2(t * 0.045, -t * 0.03);
  float pxp = snoise((x + vec2(e, 0.0)) * 0.6 + dr);
  float pxm = snoise((x - vec2(e, 0.0)) * 0.6 + dr);
  float pyp = snoise((x + vec2(0.0, e)) * 0.6 + dr);
  float pym = snoise((x - vec2(0.0, e)) * 0.6 + dr);
  vec2 curl = vec2(pyp - pym, -(pxp - pxm)) / (2.0 * e);
  return curl + vec2(0.4, 0.14); // gentle laminar bias
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Aspect-corrected square space so strokes keep their proportions.
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;

  float cell1 = 1.0 / uGrid;
  vec2 baseCell = floor(uv * uGrid);

  // Flux geometry: thick strokes (~0.6 of cell spacing wide, so half-width ~0.3)
  // whose LENGTH is set by flow speed. uDash scales length; strokes can span a
  // couple of cells in fast flow, so we walk a 5x5 neighbourhood to catch strokes
  // anchored a couple of cells away whose body reaches this pixel.
  float halfW = 0.26 * cell1;
  float lenGain = 3.6 * uDash * cell1; // uv length per unit flow speed (Flux: long)
  float maxLen = 1.95 * cell1;

  float lit = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      float r = hash21(cell);
      float r2 = hash21(cell + 7.31);

      // Stroke anchor (tail): cell centre jittered off the lattice.
      vec2 a = (cell + 0.5) * cell1 + (vec2(r, r2) - 0.5) * 0.7 * cell1;

      // Local flow → direction + speed. Length grows with speed (Flux), so calm
      // regions rest to near-nothing and fast regions draw long strokes.
      vec2 v = driftVel(a * uFlow, t);
      float speed = length(v);
      vec2 dir = v / max(speed, 1e-4);
      float len = clamp(speed * lenGain, 0.18 * cell1, maxLen);
      vec2 tip = a + dir * len; // stroke runs tail(a) -> tip, along the flow

      // Project this pixel onto the stroke: h in [0,1] along it, d perpendicular.
      vec2 pa = uv - a, ba = tip - a;
      float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
      float d = length(pa - ba * h);

      // Rounded soft edge across the width; taper the width toward both ends so
      // strokes read as clean lozenge brush marks rather than blunt capsules.
      float wProfile = halfW * (0.35 + 0.65 * sin(h * 3.14159));
      float edge = smoothstep(wProfile, wProfile * 0.25, d);

      // Brightness ramps up toward the leading tip (the flow-pushed head), like a
      // comet — the signature Flux stroke shading. Slow strokes are dim + short.
      float headGlow = 0.35 + 0.65 * h;
      float speedB = smoothstep(0.05, 0.9, speed);
      lit = max(lit, edge * headGlow * (0.5 + 0.5 * r) * speedB);
    }
  }

  // Large-scale colour regions (big magenta / green / blue zones like the
  // reference), palette-cycled and drifting slowly — colour is by position, not
  // per dash, so neighbouring dashes share a hue and read as one region.
  float creg = snoise(uv * uFlow * 0.28 + 3.0) * 0.5 + 0.5;
  vec3 col = ncCyc(creg + 0.03 * t);

  vec3 outc = uSky + col * lit * uGlow;
  float vig = 1.0 - 0.26 * dot(vUv - 0.5, vUv - 0.5);
  outc *= vig;
  outc = outc / (outc + 0.75);
  outc = pow(outc, vec3(0.85));
  gl_FragColor = vec4(outc + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_THEME = "nebula";
const DEFAULT_FLOW = 2.6;   // swirl scale
const DEFAULT_GRID = 40;    // stroke grid density (cells across the field)
const DEFAULT_DASH = 1.0;   // stroke length multiplier
const DEFAULT_GLOW = 1.8;
// Drift's signature is multi-hue (magenta / green / blue), so the default color
// stops are a vibrant triad rather than a single-hue palette. Picking a Theme in
// the UI overrides these with that palette's stops.
const DRIFT_A = "#e01e8f"; // magenta
const DRIFT_B = "#22c55e"; // emerald
const DRIFT_C = "#3b7bf5"; // blue

export class Drift extends FullscreenScene {
  readonly id = "drift";
  readonly name = "Drift";
  readonly description = "Dashes of light combed around slow vortices — the macOS Drift look.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.5, step: 0.01, default: 0.4 },
    { kind: "range", id: "scale", label: "Swirl Scale", min: 1.2, max: 5.0, step: 0.1, default: DEFAULT_FLOW },
    { kind: "range", id: "density", label: "Density", min: 28, max: 72, step: 1, default: DEFAULT_GRID },
    { kind: "range", id: "dash", label: "Stroke Length", min: 0.5, max: 1.8, step: 0.05, default: DEFAULT_DASH },
    { kind: "range", id: "glow", label: "Glow", min: 0.4, max: 2.4, step: 0.05, default: DEFAULT_GLOW },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: DEFAULT_THEME },
    { kind: "color", id: "colorA", label: "Color A", default: DRIFT_A },
    { kind: "color", id: "colorB", label: "Color B", default: DRIFT_B },
    { kind: "color", id: "colorC", label: "Color C", default: DRIFT_C },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0.4 },
        uFlow: { value: DEFAULT_FLOW },
        uGrid: { value: DEFAULT_GRID },
        uDash: { value: DEFAULT_DASH },
        uGlow: { value: DEFAULT_GLOW },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorA: { value: hexToColor(DRIFT_A) },
        uColorB: { value: hexToColor(DRIFT_B) },
        uColorC: { value: hexToColor(DRIFT_C) },
        uSky: { value: hexToColor("#04030a") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "scale":
        u.uFlow.value = Number(value);
        break;
      case "density":
        u.uGrid.value = Number(value);
        break;
      case "dash":
        u.uDash.value = Number(value);
        break;
      case "glow":
        u.uGlow.value = Number(value);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorA.value as THREE.Color).set(p.a);
        (u.uColorB.value as THREE.Color).set(p.b);
        (u.uColorC.value as THREE.Color).set(p.c);
        break;
      }
      case "colorA":
        (u.uColorA.value as THREE.Color).set(String(value));
        break;
      case "colorB":
        (u.uColorB.value as THREE.Color).set(String(value));
        break;
      case "colorC":
        (u.uColorC.value as THREE.Color).set(String(value));
        break;
    }
  }
}
