import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Synthwave / retro-outrun scene: a neon perspective grid scrolling toward the
 * viewer beneath a banded retro sun on a gradient sky. The defining 80s
 * aesthetic — high contrast, glowing, and instantly recognizable. The grid uses
 * fwidth-based anti-aliasing so the lines stay razor-sharp into the distance.
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
uniform vec3  uSky;     // top of sky
uniform vec3  uSun;     // sun / horizon glow
uniform vec3  uGrid;    // neon grid lines

const float HORIZON = 0.5;

// Bright line near integer values of coord, anti-aliased to ~1px via fwidth.
float gridLine(float coord) {
  float w = fwidth(coord) * 1.5 + 0.02;
  float f = abs(fract(coord) - 0.5);
  return smoothstep(0.5 - w, 0.5, f);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv = vUv;
  float t = uTime * uSpeed;
  vec3 col;

  if (uv.y > HORIZON) {
    // --- Sky + retro sun -------------------------------------------------
    float sky = (uv.y - HORIZON) / (1.0 - HORIZON); // 0 horizon → 1 top
    col = mix(uSun * 0.55, uSky, pow(sky, 0.8));     // warm horizon → deep top

    vec2 sc = vec2((uv.x - 0.5) * aspect, uv.y - 0.63);
    float sd = length(sc);
    float sunR = 0.17;
    // Vertical gradient across the sun disc (light top → hot bottom).
    vec3 sunCol = mix(uSun, mix(uSun, vec3(1.0, 0.95, 0.7), 0.6), clamp((0.63 - uv.y) / 0.34 + 0.5, 0.0, 1.0));
    // Classic horizontal scanline gaps, only across the lower half of the sun.
    float stripe = smoothstep(0.35, 0.65, fract((0.63 - uv.y) * 26.0));
    float gapMask = mix(1.0, stripe, smoothstep(0.63, 0.5, uv.y));
    float disc = smoothstep(sunR, sunR - 0.006, sd) * gapMask;
    col = mix(col, sunCol, disc);
    // Sun glow halo.
    col += uSun * smoothstep(sunR * 2.6, 0.0, sd) * 0.45;
  } else {
    // --- Perspective neon grid floor ------------------------------------
    col = uSky * 0.12; // dark ground
    float zy = HORIZON - uv.y;                  // 0 at horizon → 0.5 at bottom
    float persp = 0.10 / (zy + 0.0025);          // depth (large near horizon)
    float gx = (uv.x - 0.5) * aspect * persp * 3.5;
    float gz = persp * 5.0 - t * 2.0;           // scroll toward viewer
    float line = max(gridLine(gx), gridLine(gz));
    float fade = smoothstep(0.0, 0.16, zy);      // dissolve dense lines at horizon
    col += uGrid * line * fade * 1.3;
    // Reflected sun glow shimmering on the floor.
    col += uSun * smoothstep(0.16, 0.0, abs(uv.x - 0.5) * aspect) * smoothstep(0.0, 0.4, zy) * 0.15;
  }

  // Bright horizon band where sky meets grid.
  col += uSun * smoothstep(0.03, 0.0, abs(uv.y - HORIZON)) * 1.4;

  gl_FragColor = vec4(col, 1.0);
}
`;

const DEFAULT_SPEED = 0.5;

export class SynthwaveGrid extends FullscreenScene {
  readonly id = "synthwave-grid";
  readonly name = "Synthwave";
  readonly description = "Neon outrun grid racing toward a banded retro sun.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 2.0, step: 0.05, default: DEFAULT_SPEED },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "synthwave" },
    { kind: "color", id: "sky", label: "Sky", default: "#170230" },
    { kind: "color", id: "sun", label: "Sun", default: "#ff5ea0" },
    { kind: "color", id: "grid", label: "Grid", default: "#2ec2eb" },
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
        uSky: { value: hexToColor("#170230") },
        uSun: { value: hexToColor("#ff5ea0") },
        uGrid: { value: hexToColor("#2ec2eb") },
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
        (u.uSky.value as THREE.Color).set(p.a);
        (u.uSun.value as THREE.Color).set(p.b);
        (u.uGrid.value as THREE.Color).set(p.c);
        break;
      }
      case "sky":
        (u.uSky.value as THREE.Color).set(String(value));
        break;
      case "sun":
        (u.uSun.value as THREE.Color).set(String(value));
        break;
      case "grid":
        (u.uGrid.value as THREE.Color).set(String(value));
        break;
    }
  }
}
