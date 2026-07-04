import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS, remapSpeed, remapSize } from "../engine/sceneParams";
import { DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Classic plasma field — layered sines warped through a feedback term, mapped
 * onto a three-stop palette. The demoscene staple, modernized: smooth, endless,
 * hypnotic color motion with no visible seams or repetition.
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
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${DITHER}

// Cyclic 3-stop palette (A→B→C→A) so the plasma flows through many color bands
// instead of washing between two blobs.
vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5) * uScale;
  float t = uTime * uSpeed;

  // Domain-warp the field so the bands curl and fold (not flat stripes).
  vec2 w = p + vec2(sin(t * 0.3 + p.y * 0.5), cos(t * 0.27 + p.x * 0.5)) * 1.2;

  // Several sine layers at different frequencies + a moving radial source.
  float v = 0.0;
  v += sin(w.x * 1.2 + t);
  v += sin(w.y * 1.5 - t * 1.1);
  v += sin((w.x + w.y) * 0.9 + t * 0.7);
  v += sin((w.x - w.y) * 1.3 - t * 0.5);
  vec2 c = p - vec2(sin(t * 0.4), cos(t * 0.5)) * 2.5;
  v += 1.4 * sin(length(c) * 1.4 - t * 1.3);
  v *= 0.32;

  // Flowing multi-band color, plus bright filament highlights at band crests.
  vec3 col = cyc(v + t * 0.15);
  float crest = pow(abs(sin(v * 3.14159 * 2.0)), 10.0);
  col += uColorC * crest * 0.6;

  // Gentle vignette for a cinematic frame.
  float vig = 1.0 - 0.3 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.4;
const DEFAULT_SCALE = 6.0;

export class Plasma extends FullscreenScene {
  readonly id = "plasma";
  readonly name = "Plasma Field";
  readonly description = "Liquid color waves — the demoscene classic, smoothed.";

  readonly parameters = NATIVE_PARAMETERS;

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById("synthwave");
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uScale: { value: DEFAULT_SCALE },
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
        u.uSpeed.value = remapSpeed(Number(value), DEFAULT_SPEED);
        break;
      case "size":
        u.uScale.value = remapSize(Number(value), DEFAULT_SCALE);
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
