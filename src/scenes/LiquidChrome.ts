import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { SIMPLEX_2D, FBM_2D, DITHER } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Liquid Chrome — a molten metallic surface. A domain-warped fbm height field is
 * differentiated into a per-pixel normal, then lit as polished metal: a moving
 * key light gives a sharp specular streak, Fresnel reflects a palette-tinted
 * environment at grazing angles, and height-based occlusion adds depth. The
 * result is a slow, premium, mirror-like flow — same smooth/cinematic vibe as
 * the rest of the collection, with a luxe metallic twist.
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
${FBM_2D}
${DITHER}

// Cyclic 3-stop palette (A→B→C→A) for the reflected environment band.
vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

// Domain-warped height field — two folds of fbm so the metal ripples and pools
// instead of looking like flat noise.
float heightField(vec2 p, float t) {
  vec2 q = vec2(fbm2(p + vec2(0.0, t * 0.12)), fbm2(p + vec2(5.2, 1.3) - t * 0.10));
  vec2 r = vec2(fbm2(p + 1.6 * q + vec2(1.7, 9.2)), fbm2(p + 1.6 * q + vec2(8.3, 2.8)));
  return fbm2(p + 2.0 * r + vec2(t * 0.05, 0.0));
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5) * uScale;
  float t = uTime * uSpeed;

  // Central-difference normal from the height field.
  float e = 0.015 * uScale;
  float h  = heightField(p, t);
  float hx = heightField(p + vec2(e, 0.0), t) - heightField(p - vec2(e, 0.0), t);
  float hy = heightField(p + vec2(0.0, e), t) - heightField(p - vec2(0.0, e), t);
  vec3 n = normalize(vec3(-hx, -hy, e * 4.0));

  // Polished-metal lighting: moving key light → tight specular; Fresnel → env.
  vec3 view = vec3(0.0, 0.0, 1.0);
  vec3 L = normalize(vec3(cos(t * 0.3) * 0.6, sin(t * 0.27) * 0.6, 0.8));
  vec3 H = normalize(L + view);
  float spec = pow(max(dot(n, H), 0.0), 48.0);
  float fres = pow(1.0 - max(n.z, 0.0), 3.0);

  // Reflected environment: a palette band swept by the reflection vector.
  vec3 refl = reflect(-view, n);
  float band = refl.y * 0.5 + 0.5 + h * 0.25;
  vec3 env = cyc(band + t * 0.05);

  vec3 base = mix(uColorA * 0.5, uColorB, smoothstep(-0.6, 0.6, h));
  vec3 col = mix(base, env, clamp(fres + 0.25, 0.0, 1.0));
  col += spec * (uColorC * 0.6 + 0.4) * (1.2 * uIntensity);

  // Height-based ambient occlusion for depth in the troughs.
  col *= 0.7 + 0.3 * smoothstep(-1.0, 1.0, h);

  float vig = 1.0 - 0.25 * dot(vUv - 0.5, vUv - 0.5);
  gl_FragColor = vec4(col * vig + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.35;
const DEFAULT_SCALE = 3.2;
const DEFAULT_INTENSITY = 1.0;

export class LiquidChrome extends FullscreenScene {
  readonly id = "liquidchrome";
  readonly name = "Liquid Chrome";
  readonly description = "Molten mirror metal — domain-warped, lit, endlessly flowing.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.2, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Scale", min: 1.5, max: 7.0, step: 0.1, default: DEFAULT_SCALE },
    { kind: "range", id: "intensity", label: "Shine", min: 0.0, max: 1.5, step: 0.01, default: DEFAULT_INTENSITY },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "ice" },
    { kind: "color", id: "colorA", label: "Color A", default: "#040a14" },
    { kind: "color", id: "colorB", label: "Color B", default: "#3b6fae" },
    { kind: "color", id: "colorC", label: "Color C", default: "#e9f6ff" },
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
