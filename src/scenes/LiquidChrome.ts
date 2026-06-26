import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { SIMPLEX_2D, DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Liquid Chrome — flowing molten mercury. A very-low-frequency, domain-warped
 * noise surface is differentiated into a per-pixel normal and used to reflect a
 * clean studio environment (dark floor, bright sky, a crisp horizon highlight
 * line, and a soft key-light softbox). Big rounded blobs catch the horizon as a
 * curving bright streak — the signature "chrome" read — over a dark metal body,
 * with a tight specular and a palette-tinted Fresnel rim. Slow, premium, liquid.
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

${SIMPLEX_2D}
${DITHER}

vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

// Low-frequency, slowly-warped height field → big smooth liquid forms.
float heightF(vec2 p, float t) {
  vec2 w = vec2(snoise(p * 0.18 + vec2(0.0, t * 0.10)), snoise(p * 0.18 + vec2(3.3, -t * 0.08)));
  return snoise(p * 0.22 + 1.2 * w);
}

// Studio environment reflected by the surface: dark floor → bright sky, a crisp
// horizon highlight, and one soft key light. This is what makes metal read as chrome.
vec3 envMap(vec3 r) {
  float y = r.y;
  float g = smoothstep(-0.7, 0.7, y);
  vec3 c = mix(vec3(0.02, 0.025, 0.035), vec3(0.55, 0.62, 0.72), g);
  c += vec3(1.0) * smoothstep(0.06, 0.0, abs(y)) * 0.8;
  vec2 lp = vec2(r.x + 0.4, r.y - 0.55);
  c += vec3(1.0) * smoothstep(0.5, 0.0, length(lp)) * 0.7;
  return c;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5) * uScale;
  float t = uTime * uSpeed;

  float e = 0.02 * uScale;
  float h  = heightF(p, t);
  float hx = heightF(p + vec2(e, 0.0), t) - heightF(p - vec2(e, 0.0), t);
  float hy = heightF(p + vec2(0.0, e), t) - heightF(p - vec2(0.0, e), t);
  vec3 n = normalize(vec3(-hx, -hy, e * 1.5));

  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 refl = reflect(-view, n);
  vec3 col = envMap(refl);
  vec3 tint = cyc(refl.y * 0.5 + 0.5 + t * 0.04);
  col = mix(col, col * tint * 1.6, 0.25);

  vec3 L = normalize(vec3(cos(t * 0.25) * 0.7, 0.5 + 0.3 * sin(t * 0.2), 0.6));
  vec3 H = normalize(L + view);
  float spec = pow(max(dot(n, H), 0.0), 200.0);
  col += vec3(1.0) * spec * 2.0 * uIntensity;

  float fres = pow(1.0 - max(n.z, 0.0), 4.0);
  col += tint * fres * 0.3;

  float vig = 1.0 - 0.25 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.35;
const DEFAULT_SCALE = 1.2;
const DEFAULT_INTENSITY = 1.0;

export class LiquidChrome extends FullscreenScene {
  readonly id = "liquidchrome";
  readonly name = "Liquid Chrome";
  readonly description = "Flowing molten mercury under crisp studio light.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.2, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Scale", min: 0.6, max: 3.0, step: 0.05, default: DEFAULT_SCALE },
    { kind: "range", id: "intensity", label: "Shine", min: 0.0, max: 1.5, step: 0.01, default: DEFAULT_INTENSITY },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "ice" },
    { kind: "color", id: "colorA", label: "Color A", default: "#0a0f1a" },
    { kind: "color", id: "colorB", label: "Color B", default: "#6f8fc0" },
    { kind: "color", id: "colorC", label: "Color C", default: "#dbe9ff" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById("ice");
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
