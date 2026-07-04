import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";
import { NATIVE_PARAMETERS, remapSpeed, remapSize } from "../engine/sceneParams";

/**
 * Kaleidoscope: the plane is folded into N mirrored wedges, so a slowly drifting
 * noise+color field becomes an ever-evolving symmetric mandala. Nothing else in
 * the gallery is radially symmetric, so it reads as a distinct, hypnotic piece.
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
uniform float uSides;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

const float TAU = 6.28318530718;

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

// Cyclic 3-stop palette (A→B→C→A) for smooth, continuously flowing color.
vec3 cyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float t = uTime * uSpeed;

  // Slow overall rotation.
  p = rot(t * 0.1) * p;
  float r = length(p);
  float a = atan(p.y, p.x);

  // Fold into mirrored wedges → kaleidoscopic symmetry.
  float seg = TAU / uSides;
  a = abs(mod(a, seg) - seg * 0.5);
  // Clamp the breathing zoom: a zoom that swings too far pushes the pattern's
  // spatial frequency past the pixel grid and the petals alias into torn lines.
  float zoom = 2.0 + 0.35 * sin(t * 0.2);
  vec2 q = vec2(cos(a), sin(a)) * r * zoom;

  // Fade fine detail toward the center, where the fold collapses every angle
  // into a singularity that would otherwise shimmer/tear.
  float detail = smoothstep(0.03, 0.28, r);

  // Flowing field + concentric petal bands at a modest frequency.
  float n = fbm2(q * 1.15 + vec2(t * 0.15, -t * 0.1));
  float phase = r * 11.0 - t * 1.4 + n * 2.5;
  float bands = 0.5 + 0.5 * sin(phase);
  // Anti-alias the bright petal ridge with fwidth so its edges stay crisp lines
  // at any resolution instead of breaking up into torn rings.
  float bw = max(fwidth(phase), 0.001);
  float petal = smoothstep(0.62 - bw, 0.62 + bw, bands);
  float v = n * 1.2 * detail + bands * 0.35;

  vec3 col = cyc(v + t * 0.08);
  col += uColorC * petal * 0.5 * detail;          // crisp, AA'd petal highlights
  col *= 0.55 + 0.55 * smoothstep(1.4, 0.0, r);    // center bloom, edge falloff

  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.5;
const DEFAULT_SIDES = 8;

export class Kaleidoscope extends FullscreenScene {
  readonly id = "kaleidoscope";
  readonly name = "Kaleidoscope";
  readonly description = "A living mandala of mirrored, flowing color.";

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
        uSides: { value: DEFAULT_SIDES },
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
        u.uSpeed.value = remapSpeed(Number(value), 0.5);
        break;
      case "size":
        u.uSides.value = Math.round(remapSize(Number(value), 8));
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
