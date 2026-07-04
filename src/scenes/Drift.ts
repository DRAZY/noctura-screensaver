import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Drift — an homage to the macOS "Drift" screensaver. Thousands of short dashes
 * are combed along a slowly-swirling flow field: the strands are contour lines of
 * a domain-warped noise field, broken into little drifting segments, over big
 * soft regions of blended palette color. The result is that woven, brushed-
 * fingerprint texture of light streaming around vortices on black.
 *
 * It is a single fullscreen fragment shader (no particles) so it ports cleanly to
 * the native Metal / D3D savers. Per pixel it: (1) domain-warps to make vortices,
 * (2) reads a scalar noise field + its gradient, (3) draws bright bands along the
 * field's contours (strands) cut into dashes across the flow direction, and
 * (4) tints everything by a large-scale palette-cycled color field.
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

// Unit flow direction at position x: the gradient of a smooth low-frequency
// potential rotated 90 degrees → long lazy vortices. A gentle global bias keeps
// the combing laminar and dissolves the radial singularities at critical points.
vec2 flowDir(vec2 x) {
  x *= 0.6;
  float e = 0.015;
  float n0 = snoise(x);
  float nx = snoise(x + vec2(e, 0.0)) - n0;
  float ny = snoise(x + vec2(0.0, e)) - n0;
  vec2 tang = vec2(-ny, nx);
  tang = tang / (length(tang) + 1e-4);
  tang += vec2(0.55, 0.2) * 0.28;
  return normalize(tang);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Aspect-corrected square space so dashes are round-thin, not stretched.
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;

  // Dash grid in uv space. We visit the 3x3 neighbourhood so a dash whose body
  // crosses a cell border is still drawn on the neighbouring pixels.
  vec2 g = uv * uGrid;
  vec2 baseCell = floor(g);

  float dashHalf = (0.34 / uGrid) * uDash; // half length of a dash, uv units
  float dashThick = 0.14 / uGrid;          // half thickness of a dash, uv units

  // Every dash must stay within the sampled 3x3 neighbourhood or its body gets
  // clipped at a cell edge — which reads as a grid overlay. So the total off-
  // centre displacement (jitter + along-flow drift) plus the dash's own reach is
  // kept under one cell: dashHalf(0.34)+dashThick(0.12)+maxDisp(~0.52) < 1.0.
  float lit = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = baseCell + vec2(float(i), float(j));
      float r = hash21(cell);
      float r2 = hash21(cell + 7.31);
      vec2 center = (cell + 0.5) / uGrid;         // cell centre in uv space
      vec2 dir = flowDir(center * uFlow);          // orient along local flow
      vec2 perp = vec2(-dir.y, dir.x);
      // Jitter off the lattice (mostly across-flow) so no rigid rows show.
      center += (perp * (r - 0.5) * 0.5 + dir * (r2 - 0.5) * 0.25) / uGrid;
      // Each dash streams part of a cell along the flow over its life, then loops;
      // a per-cell phase staggers them so the field shimmers, never pulses.
      float life = fract(r * 13.0 + t * 0.7);
      center += dir * ((life - 0.5) * 0.55) / uGrid;
      // Fade in and out over life so dashes twinkle in rather than pop.
      float fade = smoothstep(0.0, 0.18, life) * smoothstep(1.0, 0.7, life);

      // Distance to the oriented capsule (rounded line segment) = one dash.
      vec2 rel = uv - center;
      float along = dot(rel, dir);
      float across = dot(rel, perp);
      float d = length(vec2(max(abs(along) - dashHalf, 0.0), across));
      // Fixed-width soft edge. NOT fwidth(d): d is per-cell and jumps across cell
      // boundaries, so fwidth(d) spikes there and paints a grid. The smoothstep
      // band itself (0.35..1.0 of the thickness) gives ~1px anti-aliasing.
      float m = smoothstep(dashThick, dashThick * 0.35, d);
      lit = max(lit, m * (0.5 + 0.5 * r)); // per-dash brightness variation
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
