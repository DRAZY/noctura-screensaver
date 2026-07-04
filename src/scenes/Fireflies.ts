import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { DITHER, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";
import { NATIVE_PARAMETERS, remapSpeed, remapIntensity, remapDensity, remapSize } from "../engine/sceneParams";

/**
 * Fireflies drifting through a dark gradient field. Each firefly wanders on a
 * slow noise path and pulses its glow independently, so the swarm never looks
 * synchronized. Warm, calming, organic — a nighttime-meadow mood piece.
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
uniform float uCount;
uniform float uGlow;
uniform float uSize;
uniform vec2  uResolution;
uniform vec3  uColorBg;
uniform vec3  uColorFly;

${SIMPLEX_2D}
${DITHER}

// Cheap 2D hash in [0,1] — used for static per-firefly home positions so the
// per-pixel loop never has to call simplex noise.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);

  // Subtle dark vertical gradient background.
  vec3 col = mix(uColorBg * 0.3, uColorBg, vUv.y);

  float t = uTime * uSpeed;
  int count = int(uCount);
  for (int i = 0; i < 64; i++) {
    if (i >= count) break;
    float fi = float(i);
    // Static hashed home plus a slow Lissajous wander. The previous version
    // called simplex noise twice per firefly, but the result depended only on
    // (i, t) — identical for every pixel, so it was recomputed for the whole
    // framebuffer every frame. Cheap trig gives the same drifting-swarm look.
    vec2 home = (vec2(hash21(vec2(fi, 1.0)), hash21(vec2(fi, 7.0))) - 0.5) * 2.0;
    vec2 drift = vec2(sin(t * 0.3 + fi * 1.7), sin(t * 0.27 + fi * 2.39 + 1.5707963));
    vec2 pos = (home * 0.8 + drift * 0.22) * vec2(aspect, 1.0) * 0.55;

    // Independent pulse so the swarm twinkles asynchronously.
    float pulse = 0.5 + 0.5 * sin(t * 2.0 + fi * 2.39);
    float d = length(uv - pos);
    // Size scales each firefly's glow radius (its falloff softness).
    float sz = clamp(uSize, 0.3, 3.0);
    float core = uGlow * (0.0009 * sz) / (d * d + 0.0006 * sz);
    col += uColorFly * core * (0.35 + 0.65 * pulse);
  }

  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.6;
const DEFAULT_COUNT = 36;
const DEFAULT_GLOW = 1.0;
const DEFAULT_SIZE = 1.0;

export class Fireflies extends FullscreenScene {
  readonly id = "fireflies";
  readonly name = "Fireflies";
  readonly description = "A drifting swarm of glowing fireflies in the dark.";

  readonly parameters = NATIVE_PARAMETERS;

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uCount: { value: DEFAULT_COUNT },
        uGlow: { value: DEFAULT_GLOW },
        uSize: { value: DEFAULT_SIZE },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorBg: { value: hexToColor("#05080a") },
        uColorFly: { value: hexToColor("#fad043") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = remapSpeed(Number(value), 0.6);
        break;
      case "density":
        u.uCount.value = remapDensity(Number(value), 36);
        break;
      case "intensity":
        u.uGlow.value = remapIntensity(Number(value), 1.0);
        break;
      case "size":
        u.uSize.value = remapSize(Number(value), 1.0);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorBg.value as THREE.Color).set(p.a);
        (u.uColorFly.value as THREE.Color).set(p.c);
        break;
      }
    }
  }
}
