import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Caustics: the shimmering web of light you see on the floor of a sunlit pool.
 * Built from two slowly-drifting Worley/voronoi-ish distance fields whose ridges
 * are folded into thin bright filaments, layered over a deep water gradient.
 *
 * The whole scene lives on one design rule: stay smooth. Every spatial frequency
 * is kept modest, time evolution is slow and continuous, and the filament ridges
 * are anti-aliased with `fwidth` so they soften — never alias or crawl — no matter
 * how sharp the highlight gets. That keeps it buttery on a good GPU with none of
 * the high-frequency shimmer/tearing that naive caustic shaders suffer from.
 */

export const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpeed;       // global time multiplier (slow!)
uniform float uScale;       // overall pattern scale
uniform float uSize;        // caustic cell scale → "Light Size" (smaller value = bigger cells)
uniform vec2  uResolution;
uniform vec3  uColorA;       // deep water (background floor)
uniform vec3  uColorB;       // mid water glow
uniform vec3  uColorC;       // bright caustic light

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

// Smooth 2D value hash → a stable feature point inside each lattice cell.
// fract/sin is adequate here because we only ever compare *distances*, and the
// distances are smoothed afterward, so any hash artefacts stay sub-visible.
vec2 cellPoint(vec2 cell) {
  float h = dot(cell, vec2(127.1, 311.7));
  vec2 r = vec2(sin(h) * 43758.5453, sin(h + 1.0) * 22578.1459);
  return fract(r);
}

// Worley field returning the nearest TWO distances (F1, F2). Their difference
// (F2 - F1) goes to zero exactly along cell borders — that thin border network
// is the geometry real caustics trace, so we light it rather than filling cells.
// Feature points orbit slowly so the web breathes instead of snapping.
vec2 worley(vec2 p, float t) {
  vec2 base = floor(p);
  vec2 f = fract(p);
  float f1 = 8.0;
  float f2 = 8.0;
  // 3x3 neighbourhood is sufficient because feature points stay inside their cell.
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 cell = base + vec2(float(i), float(j));
      vec2 fp = cellPoint(cell);
      fp = 0.5 + 0.5 * sin(t + 6.2831853 * fp);
      vec2 diff = vec2(float(i), float(j)) + fp - f;
      float d = length(diff);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
    }
  }
  return vec2(f1, f2);
}

// One caustic layer: a thin bright filament riding the cell-border network.
// border = F2 - F1 ≈ 0 on edges; we light a narrow band around it and AA the
// band to one screen-space gradient-width (fwidth) so it stays crisp, ~1px, and
// never aliases or crawls. pow() tightens it into a glinting light thread.
float causticLayer(vec2 p, float t, float sharp) {
  vec2 w = worley(p, t);
  float border = w.y - w.x;
  float aa = fwidth(border) + 1e-4;
  float line = 1.0 - smoothstep(0.0, 0.07 + aa, border);
  return pow(clamp(line, 0.0, 1.0), sharp);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);

  // Slow time. uSpeed defaults low; nothing here moves fast.
  float t = uTime * uSpeed;

  // Base sampling coordinate. uSize controls cell density (Light Size):
  // a larger "size" → fewer, larger light cells, so we divide the frequency by it.
  vec2 p = uv * uScale / max(uSize, 0.0001);

  // Gentle domain warp from low-frequency fbm so the caustic web drifts and
  // curls like real refracted light, instead of sitting on a static lattice.
  float warpT = t * 0.35;
  vec2 warp = vec2(
    fbm2(p * 0.35 + vec2(warpT, 0.0)),
    fbm2(p * 0.35 + vec2(0.0, warpT) + 17.3)
  );
  vec2 pw = p + warp * 0.6;

  // Two layers at slightly different scales/phases, counter-drifting. Their
  // product (not sum) is what gives caustics their characteristic bright knots
  // where two filament webs cross, with dark calm water between.
  float l1 = causticLayer(pw * 1.00, t * 0.50, 1.3);
  float l2 = causticLayer(pw * 1.37 + 9.1, -t * 0.40, 1.5);
  float caustic = l1 * 0.7 + l2 * 0.7 + l1 * l2 * 2.0;

  // Soft large-scale brightness wash so the light pools and fades across the
  // frame rather than being uniform — reads as sunlight through moving water.
  float wash = 0.5 + 0.5 * fbm2(p * 0.18 + vec2(0.0, t * 0.12));

  // Water gradient: deep colorA at the floor rising to colorB in lit areas.
  float depth = smoothstep(-0.7, 0.7, uv.y) * 0.5 + 0.5 * wash;
  vec3 water = mix(uColorA, uColorB, depth);

  // Add the caustic filaments as colorC light on top of the water, scaled by the
  // wash so highlights cluster where the water is already brighter.
  float lit = caustic * (0.55 + 0.75 * wash);
  vec3 col = water + uColorC * lit;

  // A second, very soft bloom of the brightest cores for that wet glint.
  col += uColorC * pow(clamp(caustic, 0.0, 1.0), 3.0) * 0.35;

  // Gentle vignette frames the pool of light without hard edges.
  float vig = 1.0 - 0.25 * dot(vUv - 0.5, vUv - 0.5);
  col *= vig;

  // Dither last to kill 8-bit banding in the smooth dark water gradient.
  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.4;
const DEFAULT_SCALE = 5.0;
const DEFAULT_SIZE = 1.0;
const DEFAULT_THEME = "ocean";

export class Caustics extends FullscreenScene {
  readonly id = "caustics";
  readonly name = "Caustics";
  readonly description = "Sunlit pool caustics — rippling webs of light over deep water.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.2, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Scale", min: 2.0, max: 12.0, step: 0.1, default: DEFAULT_SCALE },
    { kind: "range", id: "size", label: "Light Size", min: 0.4, max: 2.5, step: 0.01, default: DEFAULT_SIZE },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: DEFAULT_THEME },
    { kind: "color", id: "colorA", label: "Color A", default: paletteById(DEFAULT_THEME).a },
    { kind: "color", id: "colorB", label: "Color B", default: paletteById(DEFAULT_THEME).b },
    { kind: "color", id: "colorC", label: "Color C", default: paletteById(DEFAULT_THEME).c },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById(DEFAULT_THEME);
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uScale: { value: DEFAULT_SCALE },
        uSize: { value: DEFAULT_SIZE },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorA: { value: hexToColor(p.a) },
        uColorB: { value: hexToColor(p.b) },
        uColorC: { value: hexToColor(p.c) },
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
      case "size":
        u.uSize.value = Number(value);
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
