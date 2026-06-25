import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Ambient flowing-gradient scene (Aeon / Drift aesthetic). Domain-warped FBM
 * noise mapped to a three-stop palette — slow, organic, aurora-like color
 * fields. The signature default scene.
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
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Lower spatial frequency → larger, calmer, more cinematic features.
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) * 1.15;

  float t = uTime * uSpeed;
  vec2 q = vec2(fbm2(p + 0.15 * t), fbm2(p + vec2(5.2, 1.3) - 0.12 * t));
  vec2 r = vec2(
    fbm2(p + 1.8 * q + vec2(1.7, 9.2) + 0.10 * t),
    fbm2(p + 1.8 * q + vec2(8.3, 2.8) - 0.08 * t)
  );
  float f = fbm2(p + 2.2 * r);
  float m = clamp(f * 0.5 + 0.5, 0.0, 1.0);

  vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.55, m));
  col = mix(col, uColorC, smoothstep(0.45, 1.0, m));
  col += 0.06 * length(r);
  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

export const DEFAULT_SPEED = 0.18;

export class AmbientGradient extends FullscreenScene {
  readonly id = "ambient-gradient";
  readonly name = "Aurora Drift";
  readonly description = "Slow domain-warped color fields — calm, cinematic.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.02, max: 0.6, step: 0.01, default: DEFAULT_SPEED },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "aurora" },
    { kind: "color", id: "colorA", label: "Color A", default: "#1a1240" },
    { kind: "color", id: "colorB", label: "Color B", default: "#c81e8a" },
    { kind: "color", id: "colorC", label: "Color C", default: "#f5a623" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorA: { value: hexToColor("#1a1240") },
        uColorB: { value: hexToColor("#c81e8a") },
        uColorC: { value: hexToColor("#f5a623") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
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
