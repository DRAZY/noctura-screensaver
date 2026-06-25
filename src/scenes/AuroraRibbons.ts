import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Aurora ribbons (macOS XDR / "Aerial" northern-lights aesthetic). Several
 * translucent, noise-displaced vertical curtains of light sway and overlap with
 * additive glow over a dark sky. The most "wow" scene in the gallery.
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
uniform float uCount;     // number of curtains
uniform float uAmplitude; // horizontal sway
uniform float uGlow;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uSky;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

// Triangle-wave noise (after nimitz's "Auroras") — smooth, organic, and free of
// the high-frequency aliasing that makes sine-banded curtains look choppy. It
// folds the plane through rotated triangle waves to build flowing filaments.
mat2 mm2(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
float tri(float x) { return clamp(abs(fract(x) - 0.5), 0.01, 0.49); }
vec2 tri2(vec2 p) { return vec2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x))); }
float triNoise2d(vec2 p, float spd, float t) {
  float z = 1.8, z2 = 2.5, rz = 0.0;
  p = p * mm2(p.x * 0.06);
  vec2 bp = p;
  for (float i = 0.0; i < 5.0; i++) {
    vec2 dg = tri2(bp * 1.85) * 0.75;
    dg = dg * mm2(t * spd);
    p -= dg / z2;
    bp *= 1.3; z2 *= 0.45; z *= 0.42;
    p *= 1.21 + (rz - 1.0) * 0.02;
    rz += tri(p.x + tri(p.y)) * z;
    p = p * -mm2(2.0);
  }
  return clamp(1.0 / pow(rz * 29.0, 1.3), 0.0, 0.55);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y);
  float t = uTime * uSpeed;

  vec3 col = mix(uSky, uSky * 1.9, vUv.y); // vertical sky gradient

  // Layered aurora curtains. Each layer is a triangle-noise sheet, sampled with
  // the vertical axis compressed so the filaments hang as vertical rays, and
  // gently swayed side-to-side (uAmplitude) — all smooth, never strobing.
  int layers = int(clamp(uCount, 2.0, 5.0));
  vec3 aur = vec3(0.0);
  for (int i = 0; i < 5; i++) {
    if (i >= layers) break;
    float fl = float(i);
    float sway = uAmplitude * sin(vUv.y * 2.0 + t * 0.3 + fl * 1.7);
    vec2 ap = vec2(uv.x * (1.25 + fl * 0.45) + sway + fl * 4.0,
                   vUv.y * 0.7 - t * (0.05 + fl * 0.03));
    float n = triNoise2d(ap, 0.05 + fl * 0.015, t);
    // Vertical envelope: rises from the horizon, fades out near the top.
    float vEnv = smoothstep(0.0, 0.28, vUv.y) * smoothstep(1.15, 0.45, vUv.y);
    float inten = n * vEnv;

    // Green base → bright tip → a hint of violet at the crown.
    vec3 lcol = mix(uColorA, uColorB, clamp(vUv.y * 1.05, 0.0, 1.0));
    lcol = mix(lcol, vec3(0.72, 0.28, 0.96), smoothstep(0.6, 1.05, vUv.y) * 0.5);
    aur += lcol * inten * (1.5 - fl * 0.22);
  }
  col += aur * uGlow;

  // Soft horizon glow along the bottom.
  col += uColorA * smoothstep(0.22, 0.0, vUv.y) * 0.12;

  // Gentle tone curve so highlights bloom without clipping hard.
  col = col / (col + 0.7);
  col = pow(col, vec3(0.85));
  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

export class AuroraRibbons extends FullscreenScene {
  readonly id = "aurora-ribbons";
  readonly name = "Northern Lights";
  readonly description = "Translucent curtains of aurora swaying over a dark sky.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.5, step: 0.01, default: 0.5 },
    { kind: "range", id: "count", label: "Ribbons", min: 1, max: 7, step: 1, default: 5 },
    { kind: "range", id: "amplitude", label: "Sway", min: 0.0, max: 0.8, step: 0.01, default: 0.35 },
    { kind: "range", id: "glow", label: "Glow", min: 0.3, max: 2.0, step: 0.05, default: 1.1 },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "borealis" },
    { kind: "color", id: "colorA", label: "Low Color", default: "#13c285" },
    { kind: "color", id: "colorB", label: "High Color", default: "#9ef26b" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0.5 },
        uCount: { value: 5 },
        uAmplitude: { value: 0.35 },
        uGlow: { value: 1.1 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorA: { value: hexToColor("#13c285") },
        uColorB: { value: hexToColor("#9ef26b") },
        uSky: { value: hexToColor("#051721") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "count":
        u.uCount.value = Number(value);
        break;
      case "amplitude":
        u.uAmplitude.value = Number(value);
        break;
      case "glow":
        u.uGlow.value = Number(value);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uSky.value as THREE.Color).set(p.a);
        (u.uColorA.value as THREE.Color).set(p.b);
        (u.uColorB.value as THREE.Color).set(p.c);
        break;
      }
      case "colorA":
        (u.uColorA.value as THREE.Color).set(String(value));
        break;
      case "colorB":
        (u.uColorB.value as THREE.Color).set(String(value));
        break;
    }
  }
}
