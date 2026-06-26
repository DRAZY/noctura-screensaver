import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Fractal Bloom — an animated Julia set. The seed point `c` orbits a circle of
 * radius 0.7885 (the classic morphing-Julia path), so the fractal continuously
 * grows, folds, and reblooms while a slow breathing zoom adds drift. Continuous
 * (smooth) escape-time coloring maps the exterior onto the cyclic palette and a
 * soft exponential bloom lights the boundary, so there's no aliasing and no
 * banding — just an endlessly unfolding organic structure.
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
uniform float uIntensity;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${DITHER}

vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  float t = uTime * uSpeed;

  // Breathing zoom + slowly rotating frame.
  float zoom = (1.7 + 0.35 * sin(t * 0.1)) * uScale;
  float rot = t * 0.03;
  float cr = cos(rot), sr = sin(rot);
  vec2 z0 = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5) * zoom;
  vec2 z = vec2(z0.x * cr - z0.y * sr, z0.x * sr + z0.y * cr);

  // Seed orbiting the classic radius-0.7885 circle → continuous re-bloom.
  vec2 c = 0.7885 * vec2(cos(t * 0.15), sin(t * 0.15));

  float it = 0.0;
  float r2 = 0.0;
  for (int i = 0; i < 128; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    r2 = dot(z, z);
    if (r2 > 16.0) break;
    it += 1.0;
  }

  vec3 col;
  if (r2 <= 16.0) {
    // Interior: deep, lightly shaded by the last orbit radius.
    col = uColorA * (0.18 + 0.12 * r2 / 16.0);
  } else {
    // Smooth (continuous) escape time → no iteration banding.
    float sm = it - log2(log2(r2)) + 4.0;
    col = cyc(sm / 40.0 + t * 0.05);
    col *= clamp(sm / 22.0, 0.25, 1.4);
    // Soft bloom hugging the boundary (low escape time).
    col += uColorC * exp(-sm * 0.08) * (0.7 * uIntensity);
  }

  float vig = 1.0 - 0.28 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.5;
const DEFAULT_SCALE = 1.0;
const DEFAULT_INTENSITY = 1.0;

export class FractalBloom extends FullscreenScene {
  readonly id = "fractalbloom";
  readonly name = "Fractal Bloom";
  readonly description = "An animated Julia set, endlessly folding and reblooming.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.5, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Zoom", min: 0.6, max: 2.0, step: 0.01, default: DEFAULT_SCALE },
    { kind: "range", id: "intensity", label: "Bloom", min: 0.0, max: 1.5, step: 0.01, default: DEFAULT_INTENSITY },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "aurora" },
    { kind: "color", id: "colorA", label: "Color A", default: "#1a1240" },
    { kind: "color", id: "colorB", label: "Color B", default: "#c81e8a" },
    { kind: "color", id: "colorC", label: "Color C", default: "#f5a623" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById("aurora");
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uScale: { value: DEFAULT_SCALE },
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
