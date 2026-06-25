import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Deep-space starfield + nebula (Aerial "Deep Space" aesthetic). A soft
 * noise-based nebula drifts behind three parallax layers of procedurally hashed
 * stars with gentle twinkle. Fully procedural — no textures, runs for hours.
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
uniform float uDensity;     // star layer threshold
uniform float uNebula;      // nebula intensity
uniform vec2  uResolution;
uniform vec3  uNebulaColor;
uniform vec3  uStarTint;
uniform vec3  uDeepColor;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

// One parallax star layer: hashed points on a scrolling grid with a crisp core
// plus a soft halo, gently twinkling. size sets the star radius.
vec3 starLayer(vec2 uv, float scale, float drift, float threshold, vec3 tint, float size) {
  uv = uv * scale + vec2(drift, drift * 0.3);
  vec2 cell = floor(uv);
  vec2 f = fract(uv) - 0.5;
  float h = hash21(cell);
  float present = step(threshold, h);
  vec2 starPos = (vec2(hash21(cell + 1.7), hash21(cell + 4.1)) - 0.5) * 0.7;
  float d = length(f - starPos);
  float core = smoothstep(size, 0.0, d);
  float halo = smoothstep(size * 3.5, 0.0, d) * 0.35;
  float tw = 0.6 + 0.4 * sin(uTime * (1.5 + 3.0 * h) + h * 30.0);
  return tint * present * (core + halo) * tw;
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;

  // Nebula: domain-warped fbm with glowing dense cores and a secondary tone so
  // it reads as luminous gas clouds, not a flat wash.
  vec2 np = uv * 1.3 + vec2(0.04 * t, -0.02 * t);
  float n = fbm2(np + fbm2(np * 1.7 + t * 0.05));
  float neb = smoothstep(-0.2, 0.85, n);
  vec3 col = mix(uDeepColor, uNebulaColor, neb * uNebula);
  col += uNebulaColor * pow(max(n, 0.0), 3.0) * uNebula * 0.9;      // bright cores
  float n2 = fbm2(np * 0.8 + vec2(5.2, 1.7) - t * 0.03);
  col += uStarTint * smoothstep(0.45, 1.0, n2) * uNebula * 0.2;      // cool depth tone

  // Parallax stars: three drifting layers + sparse bright "hero" stars.
  float thr = mix(0.985, 0.93, clamp(uDensity, 0.0, 1.0));
  col += starLayer(uv, 14.0, t * 0.20, thr, uStarTint, 0.05) * 1.0;
  col += starLayer(uv, 9.0,  t * 0.12, thr + 0.005, uStarTint * 0.9, 0.06) * 0.8;
  col += starLayer(uv, 5.0,  t * 0.06, thr + 0.008, uStarTint * 0.8, 0.07) * 0.6;
  col += starLayer(uv, 3.0,  t * 0.03, thr + 0.02,  uStarTint * 1.4, 0.10) * 1.5;

  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

export class Starfield extends FullscreenScene {
  readonly id = "starfield";
  readonly name = "Deep Space";
  readonly description = "Parallax stars drifting through a soft nebula.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.2, step: 0.01, default: 0.4 },
    { kind: "range", id: "density", label: "Star Density", min: 0.0, max: 1.0, step: 0.01, default: 0.5 },
    { kind: "range", id: "nebula", label: "Nebula", min: 0.0, max: 1.5, step: 0.01, default: 0.9 },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "deepspace" },
    { kind: "color", id: "nebulaColor", label: "Nebula Color", default: "#3a2f8f" },
    { kind: "color", id: "starTint", label: "Star Tint", default: "#cfe0ff" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0.4 },
        uDensity: { value: 0.5 },
        uNebula: { value: 0.9 },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uNebulaColor: { value: hexToColor("#3a2f8f") },
        uStarTint: { value: hexToColor("#cfe0ff") },
        uDeepColor: { value: hexToColor("#02030a") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "density":
        u.uDensity.value = Number(value);
        break;
      case "nebula":
        u.uNebula.value = Number(value);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uDeepColor.value as THREE.Color).set(p.a);
        (u.uNebulaColor.value as THREE.Color).set(p.b);
        (u.uStarTint.value as THREE.Color).set(p.c);
        break;
      }
      case "nebulaColor":
        (u.uNebulaColor.value as THREE.Color).set(String(value));
        break;
      case "starTint":
        (u.uStarTint.value as THREE.Color).set(String(value));
        break;
    }
  }
}
