import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS } from "../engine/sceneParams";
import { SIMPLEX_2D, FBM_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Particle Drift — the per-pixel particle field that the native `.saver`/`.scr`
 * builds render. It fakes a drifting particle swarm entirely in the fragment
 * shader: four layers of a jittered cell grid, each cell holding one bright point
 * displaced by an fbm flow field, composited additively. This is a verbatim GLSL
 * port of the Metal `sceneParticles` / HLSL `sceneParticles`, so scene 3 renders
 * the same image on web, macOS, and Windows.
 *
 * (The GPU point-cloud version — 60k real instanced points — lives separately as
 * "Particle Swarm".)
 */

const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpeed;
uniform float uIntensity;
uniform float uDensity;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${SIMPLEX_2D}
${FBM_2D}

// Matches the native hash21 exactly.
float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 345.45));
  p += dot(p, p + 34.345);
  return fract(p.x * p.y);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 uv0 = vUv;
  vec2 p = vec2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * 2.2;
  float t = uTime * uSpeed;
  // Slow rotation, mirroring the app's points.rotation.y = time * 0.03.
  float ca = cos(t * 0.03), sa = sin(t * 0.03);
  p = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  vec3 col = uColorA * 0.05;
  float thr = mix(0.92, 0.55, clamp(uDensity, 0.0, 1.0));
  for (int L = 0; L < 4; L++) {
    float fl = float(L);
    float scale = 5.0 + fl * 4.0;
    vec2 fp = p * 0.7 + fl * 3.1;
    vec2 flow = vec2(fbm2(fp + vec2(0.0, t * 0.15)),
                     fbm2(fp + vec2(5.2, 1.3) - t * 0.12));
    float flowLen = length(flow);
    vec2 g = p * scale + flow * 1.8;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;
    float h = hash21(cell + fl * 17.0);
    float present = step(thr, h);
    vec2 pp = (vec2(hash21(cell + 2.3), hash21(cell + 8.1)) - 0.5) * 0.7;
    float d = length(f - pp);
    // Bright core + soft halo → luminous additive bloom (matches app FRAG).
    float core = smoothstep(0.16, 0.0, d);
    float halo = smoothstep(0.42, 0.0, d) * 0.35;
    float glow = present * (1.6 * core + 0.5 * halo) * (0.5 + 0.5 * h);
    vec3 tint = mix(uColorB, uColorC, clamp(flowLen * 0.9, 0.0, 1.0));
    col += tint * glow * (1.3 * uIntensity) * (1.0 - fl * 0.12);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const DEFAULT_THEME = "aurora";

export class ParticleDrift extends FullscreenScene {
  readonly id = "particle-drift";
  readonly name = "Particle Drift";
  readonly description = "A drifting particle field flowing through fbm currents — the native-saver look.";

  readonly parameters = NATIVE_PARAMETERS;

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById(DEFAULT_THEME);
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        // Raw native-control values (the shader is a verbatim port that reads them
        // directly, exactly like the native uniform block — no per-scene remap).
        uSpeed: { value: 0.3 },
        uIntensity: { value: 1.0 },
        uDensity: { value: 0.5 },
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
      case "intensity":
        u.uIntensity.value = Number(value);
        break;
      case "density":
        u.uDensity.value = Number(value);
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
