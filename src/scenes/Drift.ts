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
// potential): vel = (dPot/dy, -dPot/dx). Unlike a normalized direction this
// keeps the true magnitude, so — exactly like Flux/Drift — the flow is fast in
// some places and near-still in others, which we use to vary dash length and
// brightness. A gentle constant bias keeps the combing laminar and stops the
// dashes from spinning wildly around critical points.
vec2 driftVel(vec2 x, float t) {
  float e = 0.02;
  // Two slowly-drifting octaves → big lazy vortices that evolve over time.
  // potential(p) = snoise(p*0.6 + drift) + 0.5*snoise(p*1.3 + drift2)
  vec2 d1 = vec2(0.0, t * 0.05);
  vec2 d2 = vec2(t * 0.04, 0.0);
  float pxp = snoise((x + vec2(e, 0.0)) * 0.6 + d1) + 0.5 * snoise((x + vec2(e, 0.0)) * 1.3 + d2);
  float pxm = snoise((x - vec2(e, 0.0)) * 0.6 + d1) + 0.5 * snoise((x - vec2(e, 0.0)) * 1.3 + d2);
  float pyp = snoise((x + vec2(0.0, e)) * 0.6 + d1) + 0.5 * snoise((x + vec2(0.0, e)) * 1.3 + d2);
  float pym = snoise((x - vec2(0.0, e)) * 0.6 + d1) + 0.5 * snoise((x - vec2(0.0, e)) * 1.3 + d2);
  vec2 curl = vec2(pyp - pym, -(pxp - pxm)) / (2.0 * e);
  return curl + vec2(0.35, 0.12); // laminar bias
}

// Distance from p to the segment a→b (for drawing a rounded line as a capsule).
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Aspect-corrected square space so dashes are round-thin, not stretched.
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;

  // Dash grid in uv space; 3x3 neighbourhood so a dash whose curved body crosses
  // a cell border is still drawn on neighbouring pixels.
  vec2 g = uv * uGrid;
  vec2 baseCell = floor(g);

  float cell1 = 1.0 / uGrid;
  float dashThick = 0.13 * cell1;   // half thickness of a dash, uv units

  float lit = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      float r = hash21(cell);
      float r2 = hash21(cell + 7.31);

      // Anchor: cell centre, jittered off the lattice so no rigid rows show.
      vec2 b = (cell + 0.5) * cell1 + (vec2(r, r2) - 0.5) * 0.55 * cell1;

      // Sample the flow at the anchor. Speed drives length + brightness so slow
      // water thins out and fast water combs into long bright strokes (Flux).
      vec2 v0 = driftVel(b * uFlow, t);
      float speed = length(v0);
      vec2 dir = v0 / max(speed, 1e-4);
      float amp = smoothstep(0.15, 1.1, speed); // 0 in still water, 1 in fast flow

      // One short capsule oriented along the local flow, centred on the anchor.
      // Length grows with flow speed and uDash. It's intentionally a single
      // straight segment: the field's curvature emerges from thousands of short
      // dashes each aligned to their own local flow, exactly like the reference —
      // per-dash bending only produces kinks, not smoother curves.
      float halfLen = (0.3 + 0.55 * amp) * uDash * cell1;
      vec2 back = b - dir * halfLen;
      vec2 fwd = b + dir * halfLen;

      // Animate: slide the phase along the flow so dashes stream and twinkle.
      float life = fract(r * 13.0 + t * 0.6);
      float fade = smoothstep(0.0, 0.2, life) * smoothstep(1.0, 0.65, life);

      // Distance to the capsule (rounded line) = one dash. Fixed-width soft edge
      // (NOT fwidth: d is per-cell and jumps at borders, which paints a grid).
      float d = segDist(uv, back, fwd);
      float m = smoothstep(dashThick, dashThick * 0.3, d);
      lit = max(lit, m * (0.45 + 0.55 * r) * (0.35 + 0.65 * amp) * fade);
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
const DEFAULT_FLOW = 2.4;   // swirl scale
const DEFAULT_GRID = 52;    // dashes across the field
const DEFAULT_DASH = 1.1;   // dash length
const DEFAULT_GLOW = 1.7;
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
    { kind: "range", id: "density", label: "Density", min: 32, max: 96, step: 1, default: DEFAULT_GRID },
    { kind: "range", id: "dash", label: "Dash Length", min: 0.5, max: 1.8, step: 0.05, default: DEFAULT_DASH },
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
