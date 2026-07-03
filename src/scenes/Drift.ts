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
uniform float uScale;    // swirl size (smaller = larger, lazier vortices)
uniform float uStrands;  // number of combed strands
uniform float uGlow;     // streak brightness
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform vec3  uSky;      // near-black background

${SIMPLEX_2D}
${DITHER}

// Number of Line-Integral-Convolution steps taken in EACH flow direction. The
// substance noise is smeared this many taps forward and backward along the flow,
// which is what turns isolated speckles into combed, flow-aligned streaks.
#define LIC_STEPS 9

// Smooth A->B->C->A cycle so the big color regions braid through all three stops.
vec3 ncCyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

// Single-octave simplex is a smooth, low-frequency potential at these scales — the
// flow direction is its gradient rotated 90 degrees, giving long lazy vortices
// (contour-band methods ring into moiré at vortex centers; LIC does not).
vec2 flowDir(vec2 x) {
  x *= 0.62; // low frequency → big, lazy vortices (fewer critical points)
  float e = 0.012;
  float n0 = snoise(x);
  float nx = snoise(x + vec2(e, 0.0)) - n0;
  float ny = snoise(x + vec2(0.0, e)) - n0;
  vec2 tang = vec2(-ny, nx);             // 90 degrees from gradient = along-flow
  tang = tang / (length(tang) + 1e-4);   // unit tangent
  // A gentle global drift bias makes the combing laminar and — because it
  // dominates exactly where the gradient vanishes — dissolves the radial
  // "starburst" singularities that a pure noise-curl field produces.
  tang += vec2(0.5, 0.18) * 0.32;
  return normalize(tang);
}

// The "ink" the flow combs: sparse high-frequency speckles. LIC stretches each
// speckle along the local flow into a short dash, and the gaps between speckles
// become the gaps between dashes.
float substance(vec2 x) {
  float n = snoise(x * uStrands * 0.5);
  return smoothstep(-0.25, 0.65, n);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;
  vec2 p = uv * uScale;

  // Slow evolving domain warp so the whole flow field breathes and drifts.
  vec2 pw = p + 0.4 * vec2(
    snoise(p * 0.4 + vec2(0.0, t * 0.06)),
    snoise(p * 0.4 + vec2(5.0, -t * 0.05))
  );
  // A gentle along-flow scroll so the dashes stream rather than merely morph.
  vec2 drift = flowDir(pw) * (t * 0.12);

  // Line Integral Convolution: average the substance along the flow line through
  // this pixel, weighting the center most. The result is a streak tangent to the
  // flow — the brushed/combed look, free of the banding moiré.
  float stepLen = 0.035;
  float acc = 0.0, wsum = 0.0;
  vec2 pos = pw;
  for (int i = 0; i < LIC_STEPS; i++) {
    float w = 1.0 - float(i) / float(LIC_STEPS);
    acc += substance(pos + drift) * w;
    wsum += w;
    pos += flowDir(pos) * stepLen;
  }
  pos = pw;
  for (int i = 0; i < LIC_STEPS; i++) {
    pos -= flowDir(pos) * stepLen;
    float w = 1.0 - float(i) / float(LIC_STEPS);
    acc += substance(pos + drift) * w;
    wsum += w;
  }
  float streak = acc / wsum;
  // Sharpen the smeared average back into crisp dashes with clean black gaps.
  streak = smoothstep(0.22, 0.62, streak);

  // Large-scale coverage → big soft regions rest toward black (negative space),
  // but leave most of the frame combed like the reference.
  float cover = snoise(p * 0.45 + vec2(9.0, -t * 0.03));
  streak *= smoothstep(-0.7, 0.35, cover);

  // Large-scale color regions, palette-cycled and slowly evolving: a few big soft
  // colored zones (magenta / green / blue in the reference), not per-strand color.
  float creg = snoise(p * 0.32 + 3.0) * 0.5 + 0.5;
  vec3 col = ncCyc(creg + 0.03 * t);

  vec3 outc = uSky + col * streak * uGlow;
  // Soft tone curve + vignette so bright streaks bloom without clipping.
  float vig = 1.0 - 0.28 * dot(vUv - 0.5, vUv - 0.5);
  outc *= vig;
  outc = outc / (outc + 0.7);
  outc = pow(outc, vec3(0.82));
  gl_FragColor = vec4(outc + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_THEME = "nebula";
const DEFAULT_SCALE = 1.9;
const DEFAULT_STRANDS = 30;
const DEFAULT_GLOW = 1.9;
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
    { kind: "range", id: "scale", label: "Swirl Scale", min: 1.5, max: 6.0, step: 0.1, default: DEFAULT_SCALE },
    { kind: "range", id: "density", label: "Strands", min: 24, max: 90, step: 1, default: DEFAULT_STRANDS },
    { kind: "range", id: "glow", label: "Glow", min: 0.4, max: 2.2, step: 0.05, default: DEFAULT_GLOW },
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
        uScale: { value: DEFAULT_SCALE },
        uStrands: { value: DEFAULT_STRANDS },
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
        u.uScale.value = Number(value);
        break;
      case "density":
        u.uStrands.value = Number(value);
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
