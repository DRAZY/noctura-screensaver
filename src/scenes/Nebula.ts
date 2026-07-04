import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS, remapSpeed, remapDensity, remapIntensity, remapSize } from "../engine/sceneParams";
import { SIMPLEX_2D, FBM_2D, DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Nebula Drift — a luminous interstellar gas cloud. Domain-warped fbm builds the
 * gas; a second noise field carves dark dust lanes; the result is thresholded so
 * the voids fall to black and the dense filaments glow with HDR cores tonemapped
 * back into range. A separate low-frequency field drives the hue so the cloud is
 * genuinely multi-colored (not one flat wash), with cyan-white hot cores, a soft
 * galactic glow, and a sparse twinkling point-starfield behind it.
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

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

// Sparse point stars: per-cell random position with a soft radial falloff and a
// twinkle. Two scales for depth. (Point-based, so no blocky cell artifacts.)
float starField(vec2 uv, float t) {
  float s = 0.0;
  for (int k = 0; k < 2; k++) {
    float sc = 110.0 + float(k) * 160.0;
    vec2 g = uv * sc;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(cell + float(k) * 37.0);
    if (h > 0.88) {
      vec2 off = (vec2(hash21(cell + 1.3), hash21(cell + 4.7)) - 0.5) * 0.7;
      float d = length(f - off);
      float bright = (h - 0.88) / 0.12;
      s += smoothstep(0.08, 0.0, d) * bright * (0.5 + 0.5 * sin(t * 2.0 + h * 60.0));
    }
  }
  return s;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  vec2 p = uv * uScale;
  float t = uTime * uSpeed;

  vec3 col = vec3(0.0);
  vec2 w = vec2(fbm2(p * 0.5 + vec2(0.0, t * 0.05)), fbm2(p * 0.5 + vec2(5.2, 1.3) - t * 0.04));
  float d = fbm2(p * 0.7 + 1.7 * w);
  float dust = fbm2(p * 1.4 + 3.1 * w + vec2(11.0, 4.0));

  // Density slider lowers the void threshold → more of the frame fills with gas.
  float voidThr = mix(0.46, 0.22, clamp(uDensity, 0.0, 1.0));
  float dens = clamp((d * 0.5 + 0.5 - voidThr - 0.34 * max(dust, 0.0)) / 0.62, 0.0, 1.0);
  float emission = pow(dens, 1.9);

  float hue = fbm2(p * 0.30 + vec2(t * 0.02, 5.0)) * 0.6 + 0.5;
  vec3 gas = cyc(hue + 0.25 * d);
  col += gas * emission * 3.2 * uIntensity;

  // Hot cyan-white cores in the densest gas.
  col += mix(vec3(0.6, 0.9, 1.0), vec3(1.0, 0.96, 0.9), hue) * pow(dens, 5.0) * 2.0;

  // Broad soft galactic glow so deep space isn't pure black.
  float glow = exp(-dot(uv, uv) * 0.9);
  col += mix(uColorB, uColorC, 0.4) * glow * 0.5;

  col += vec3(0.9, 0.95, 1.0) * starField(uv, t);
  col = col / (1.0 + col * 0.30); // soft tonemap for the HDR cores

  float vig = 1.0 - 0.28 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.4;
const DEFAULT_SCALE = 2.0;
const DEFAULT_DENSITY = 0.5;
const DEFAULT_INTENSITY = 1.0;

export class Nebula extends FullscreenScene {
  readonly id = "nebula";
  readonly name = "Nebula Drift";
  readonly description = "A luminous, multi-colored interstellar gas cloud.";

  readonly parameters = NATIVE_PARAMETERS;

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
        u.uSpeed.value = remapSpeed(Number(value), DEFAULT_SPEED);
        break;
      case "density":
        u.uDensity.value = remapDensity(Number(value), DEFAULT_DENSITY);
        break;
      case "intensity":
        u.uIntensity.value = remapIntensity(Number(value), DEFAULT_INTENSITY);
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
