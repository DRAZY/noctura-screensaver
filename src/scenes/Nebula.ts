import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { SIMPLEX_2D, FBM_2D, DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Nebula Drift — a deep-space gas cloud with parallax depth. Five domain-warped
 * fbm layers drift at different rates and scales, stacked back-to-front so the
 * cloud feels volumetric, then lit additively through the palette so the densest
 * filaments glow. A sparse twinkling starfield sits behind it. Faux-volumetric
 * (layered 2D, not a raymarch) so it stays smooth on any GPU while reading as
 * genuinely three-dimensional.
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
uniform float uSpeed;
uniform float uScale;
uniform float uDensity;
uniform float uIntensity;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

float starHash(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  vec2 p = uv * uScale;
  float t = uTime * uSpeed;

  // Deep base tint.
  vec3 col = uColorA * 0.18;

  // Sparse twinkling stars behind the gas.
  vec2 sg = floor((uv * 2.0 + 0.5) * 90.0);
  float sh = starHash(sg);
  float star = smoothstep(0.985, 1.0, sh);
  float tw = 0.5 + 0.5 * sin(t * 3.0 + sh * 100.0);
  col += vec3(0.7, 0.8, 1.0) * star * tw * 0.9;

  // Parallax cloud layers, back (faint, slow, large) to front (bright, fast).
  float thr = mix(0.45, 0.05, clamp(uDensity, 0.0, 1.0));
  for (int L = 0; L < 5; L++) {
    float fl = float(L);
    float depth = 1.0 + fl * 0.6;
    vec2 q = p / depth + vec2(t * 0.02 * (1.0 + fl * 0.3), -t * 0.015 * fl);
    // Domain warp so the gas curls into filaments.
    vec2 w = vec2(fbm2(q + vec2(0.0, t * 0.05)), fbm2(q + vec2(3.1, 1.2)));
    float d = fbm2(q + 1.4 * w);
    float cloud = smoothstep(thr, thr + 0.55, d * 0.5 + 0.5);
    vec3 tint = cyc(d * 0.5 + 0.5 + fl * 0.12 + t * 0.03);
    col += tint * cloud * (0.55 / depth) * uIntensity;
  }

  float vig = 1.0 - 0.3 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.4;
const DEFAULT_SCALE = 2.6;
const DEFAULT_DENSITY = 0.5;
const DEFAULT_INTENSITY = 1.0;

export class Nebula extends FullscreenScene {
  readonly id = "nebula";
  readonly name = "Nebula Drift";
  readonly description = "A layered interstellar gas cloud with parallax depth and starlight.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.2, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Scale", min: 1.2, max: 6.0, step: 0.1, default: DEFAULT_SCALE },
    { kind: "range", id: "density", label: "Density", min: 0.0, max: 1.0, step: 0.01, default: DEFAULT_DENSITY },
    { kind: "range", id: "intensity", label: "Glow", min: 0.0, max: 1.5, step: 0.01, default: DEFAULT_INTENSITY },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "nebula" },
    { kind: "color", id: "colorA", label: "Color A", default: "#0a0418" },
    { kind: "color", id: "colorB", label: "Color B", default: "#7b2ff7" },
    { kind: "color", id: "colorC", label: "Color C", default: "#f76fd4" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById("nebula");
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uScale: { value: DEFAULT_SCALE },
        uDensity: { value: DEFAULT_DENSITY },
        uIntensity: { value: DEFAULT_INTENSITY },
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
      case "density":
        u.uDensity.value = Number(value);
        break;
      case "intensity":
        u.uIntensity.value = Number(value);
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
