import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Flux Drift — an homage to the macOS "Drift" screensaver and its open-source
 * tribute Flux (github.com/sandydoo/flux). Long luminous streaks are combed along
 * a slow, divergence-free flow field and pile up into flowing ribbons of light
 * that curl around vortices — bright where the current runs fast, fading to black
 * where it rests — over big soft regions of palette colour.
 *
 * Technique (validated against Flux — see docs/DRIFT_FLUX_RESEARCH.md): a single
 * fullscreen fragment shader with no persistent state. The flow velocity is the
 * curl of a slowly-evolving 3-octave simplex "stream function", kept UN-normalized
 * so its magnitude is the local flow speed. For each pixel we visit a
 * neighbourhood of grid basepoints; from each we integrate a short streamline
 * (RK2) whose length AND width scale with local speed, take the pixel's distance
 * to that streamline, taper it head-to-tail, and ACCUMULATE ADDITIVELY across all
 * nearby streamlines. The two things that make it read as Flux rather than a field
 * of stubs: streamlines long enough to overlap + additive blending, and
 * width/opacity that collapse to zero in calm water. Big palette-cycled colour
 * zones tint the result. Ports cleanly to the native Metal / D3D savers.
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
uniform float uGrid;     // grid density (cells across the field)
uniform float uLen;      // streamline length in cells (<= SEARCH)
uniform float uGlow;     // additive brightness gain
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform vec3  uSky;      // near-black background

${SIMPLEX_2D}
${DITHER}

// Fixed tunables. This scene's cost is (2*SEARCH+1)^2 * KSTEPS * (noise evals) per
// pixel — the dominant GPU budget — so SEARCH/KSTEPS and the noise cost are kept
// small. The flow uses CHEAP 2D simplex (not 3D): the earlier 3D-noise,
// SEARCH=3/KSTEPS=4 version measured 605 ms/frame at Retina and pegged GPUs; this
// is ~9x lighter. The engine's adaptive controller bounds it further per-GPU.
#define KSTEPS 3                    // streamline polyline segments (Euler)
#define SEARCH 2                    // basepoint neighbourhood half-width (>= uLen)
const float LINE_BEGIN_OFFSET = 0.4;
const float LINE_VARIANCE = 0.55;
const float SPEED_GAIN = 2.6;       // width_boost = clamp(GAIN * |v|, 0, 1)
const float HALF_WIDTH = 0.20;      // stroke half-width in cells at full speed
const float HEAD_GLOW = 0.22;       // extra brightness at the leading tip

// A->B->C->A palette cycle for the big colour zones.
vec3 ncCyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Cheap flow stream-function: one octave of 2D simplex whose sample point drifts
// slowly with time (evolution without the cost of 3D noise) — the single biggest
// cost lever in this scene, which samples it ~(2*SEARCH+1)^2 * KSTEPS times/pixel.
float streamPsi(vec2 p, float t) {
  vec2 dr = vec2(t * 0.06, -t * 0.045);
  return snoise(p * 0.9 + dr);
}

// Flow velocity = curl of the stream function (forward differences: 3 taps, not 4).
// UN-normalized so |v| is the local flow speed, which drives streak length/width/
// brightness. A small constant laminar bias keeps flow moving where the gradient
// vanishes, killing the radial "starburst" singularities short streaks expose.
vec2 velocityAt(vec2 p, float t) {
  const float e = 0.9;
  float c  = streamPsi(p, t);
  float dx = streamPsi(p + vec2(e, 0.0), t) - c;
  float dy = streamPsi(p + vec2(0.0, e), t) - c;
  return vec2(dy, -dx) / e + vec2(0.22, 0.08);
}

// Total streak brightness at a pixel: gather the streamlines seeded at every
// grid basepoint in a (2*SEARCH+1)^2 neighbourhood, integrate each one, and add
// (never max) its contribution so overlapping streaks bloom into ribbons.
float streakField(vec2 uv, float t) {
  float cell = 1.0 / uGrid;
  vec2 baseId = floor(uv / cell);
  float lenCells = clamp(uLen, 1.0, float(SEARCH)); // streaks must fit the search box
  float accum = 0.0;
  for (int j = -SEARCH; j <= SEARCH; j++) {
    for (int i = -SEARCH; i <= SEARCH; i++) {
      vec2 cellId = baseId + vec2(float(i), float(j));
      vec2 bp = (cellId + 0.5) * cell;                 // basepoint = grid node
      vec2 v0 = velocityAt(bp * uFlow, t);
      float boost = smoothstep(0.0, 1.0, clamp(SPEED_GAIN * length(v0), 0.0, 1.0));
      if (boost < 0.01) continue;                      // calm water → no streak
      float rnd = hash21(cellId);
      float variance = mix(1.0 - LINE_VARIANCE, 1.0, rnd);
      float lineLen = lenCells * cell * boost * variance;
      // Streak half-width, floored to ~2 screen pixels so strokes never shrink
      // below visibility when the adaptive controller drops to a low resolution on
      // a weak GPU (without this, the thin world-space strokes vanish and the
      // scene reads as black at low res).
      float halfW = max(HALF_WIDTH * cell * boost, 2.2 * fwidth(uv.y));
      if (lineLen < 1e-5) continue;
      if (dot(uv - bp, uv - bp) > (lineLen + halfW) * (lineLen + halfW)) continue; // AABB reject

      float ds = lineLen / float(KSTEPS);
      vec2 pPrev = bp;
      vec2 vPrev = v0;                                 // reuse the boost-check sample
      float best = 1e9, bestS = 0.0, arc = 0.0;
      for (int k = 0; k < KSTEPS; k++) {               // integrate the streamline (Euler)
        vec2 dk = vPrev / max(length(vPrev), 1e-5);
        vec2 pNext = pPrev + dk * ds;
        vec2 pa = uv - pPrev, ba = pNext - pPrev;
        float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
        float d = length(pa - ba * hh);
        float s = (arc + hh * ds) / lineLen;           // 0 at base, 1 at tip
        if (d < best) { best = d; bestS = s; }
        arc += ds; pPrev = pNext;
        vPrev = velocityAt(pPrev * uFlow, t);          // one velocity eval per step
      }
      float fade = smoothstep(LINE_BEGIN_OFFSET, 1.0, bestS); // tail fades out
      // Anti-alias width, clamped to never exceed the stroke's own half-width.
      // Screen-space (1.5px via fwidth of the CONTINUOUS uv.y — no resolution
      // uniform, and no per-cell seam spike) for crisp edges at high resolution;
      // but capped at 0.9*halfW so that at LOW resolution — where the adaptive
      // controller runs a heavy scene, and where a raw screen-space AA would grow
      // wider than the thin strokes and wash them to black — the stroke centre
      // still renders bright. This is what keeps Flux Drift visible at every scale.
      float aa = min(1.5 * fwidth(uv.y), halfW * 0.9) + 1e-5;
      float edge = 1.0 - smoothstep(halfW - aa, halfW, best);
      float alpha = boost * fade * edge;
      if (alpha <= 0.0) continue;
      alpha += HEAD_GLOW * smoothstep(0.8, 1.0, bestS) * edge * boost; // head bead
      accum += alpha;                                  // ADDITIVE accumulation
    }
  }
  return accum;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5); // aspect-corrected, centred
  float t = uTime * uSpeed;

  float b = streakField(uv, t);

  // Big, smooth palette-cycled colour zones (coherent per region, like Flux's
  // velocity wash). A low-frequency noise gives the organic zone shapes; a gentle
  // diagonal gradient sweeps the whole frame through all three palette stops so
  // every colour is present (not just a narrow band). One cheap lookup.
  float creg = 0.7 * snoise(uv * uFlow * 0.22 + vec2(t * 0.05, 0.0))
             + 0.55 * (uv.x + uv.y) + 0.04 * t;
  vec3 tint = ncCyc(creg);

  vec3 outc = uSky + tint * b * uGlow;
  float vig = 1.0 - 0.26 * dot(vUv - 0.5, vUv - 0.5);
  outc *= vig;
  outc = outc / (outc + 0.85);                         // soft tone-map (bloom)
  outc = pow(outc, vec3(0.85));
  gl_FragColor = vec4(outc + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_THEME = "nebula";
const DEFAULT_FLOW = 2.0;   // swirl scale
const DEFAULT_GRID = 33;    // grid density (cells across the field)
const DEFAULT_LEN = 2.0;    // streamline length in cells (must be <= SEARCH=2)
const DEFAULT_GLOW = 1.6;
// Drift's signature is multi-hue (magenta / green / blue), so the default color
// stops are a vibrant triad rather than a single-hue palette. Picking a Theme in
// the UI overrides these with that palette's stops.
const DRIFT_A = "#e01e8f"; // magenta
const DRIFT_B = "#22c55e"; // emerald
const DRIFT_C = "#3b7bf5"; // blue

export class Drift extends FullscreenScene {
  readonly id = "drift";
  readonly name = "Flux Drift";
  readonly description = "Dashes of light combed around slow vortices — the macOS Drift look.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.5, step: 0.01, default: 0.3 },
    { kind: "range", id: "scale", label: "Swirl Scale", min: 1.2, max: 4.0, step: 0.1, default: DEFAULT_FLOW },
    { kind: "range", id: "density", label: "Density", min: 24, max: 46, step: 1, default: DEFAULT_GRID },
    { kind: "range", id: "dash", label: "Stroke Length", min: 1.0, max: 2.0, step: 0.1, default: DEFAULT_LEN },
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
        uSpeed: { value: 0.3 },
        uFlow: { value: DEFAULT_FLOW },
        uGrid: { value: DEFAULT_GRID },
        uLen: { value: DEFAULT_LEN },
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
        u.uLen.value = Number(value);
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
