import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";
import { NATIVE_PARAMETERS, remapSpeed, remapIntensity, remapSize } from "../engine/sceneParams";

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

  // Zoomed in so the dendritic structure fills the frame.
  float zoom = 1.3 * uScale;
  vec2 z = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5) * zoom;

  // Seed animated near a beautiful dendritic value → continuous re-bloom.
  vec2 c = vec2(-0.4, 0.6) + 0.12 * vec2(cos(t * 0.13), sin(t * 0.17));

  // Orbit trap (closest approach of the orbit to the origin) → glowing veins.
  float trap = 1e9;
  float it = 0.0;
  float r2 = 0.0;
  for (int i = 0; i < 100; i++) {
    z = vec2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
    r2 = dot(z, z);
    trap = min(trap, length(z));
    if (r2 > 64.0) break;
    it += 1.0;
  }

  vec3 col;
  if (r2 <= 64.0) {
    // Interior, lit by the orbit trap so it glows from within.
    col = cyc(trap * 2.0 + t * 0.05) * (0.3 + 0.6 * exp(-trap * 3.0));
  } else {
    // Smooth (continuous) escape time → no iteration banding.
    float sm = it - log2(log2(r2)) + 4.0;
    col = cyc(sm * 0.04 + t * 0.05);
    col *= 0.4 + 0.6 * sin(sm * 0.3) * sin(sm * 0.3);          // banded contrast
    col += uColorC * exp(-trap * 4.0) * (1.2 * uIntensity);    // bloom on the veins
    col += vec3(1.0) * pow(max(0.0, 1.0 - sm * 0.05), 3.0) * 0.3;
    col *= exp(-sm * 0.012);                                   // darken far exterior
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

  readonly parameters = NATIVE_PARAMETERS;

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
        u.uSpeed.value = remapSpeed(Number(value), 0.5);
        break;
      case "size":
        u.uScale.value = remapSize(Number(value), 1.0);
        break;
      case "intensity":
        u.uIntensity.value = remapIntensity(Number(value), 1.0);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorA.value as THREE.Color).set(p.a);
        (u.uColorB.value as THREE.Color).set(p.b);
        (u.uColorC.value as THREE.Color).set(p.c);
        break;
      }
    }
  }
}
