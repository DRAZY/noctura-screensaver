import * as THREE from "three";
import type { ParameterValue } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS, remapSpeed, remapSize } from "../engine/sceneParams";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Endless hyperspace tunnel. Screen-space polar coordinates with a `1/r` depth
 * mapping create the illusion of flying down an infinite shaft; FBM noise on the
 * tunnel wall plus a bright vanishing point give it depth and motion. Hypnotic
 * and energetic — a great contrast to the calmer ambient scenes.
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
uniform float uTwist;
uniform vec2  uResolution;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = uTime * uSpeed;

  // Depth coordinate: things near the center are "far away".
  float depth = 0.35 / max(r, 0.04) + t * 2.0;

  // Wall texture sampled on a CIRCLE (cos/sin of the angle) so it is periodic
  // around the tube with no atan() branch-cut seam along the -X axis. Twist
  // shears the angle with depth so the tube spirals; the depth term scrolls the
  // texture toward the viewer.
  float spin = a + uTwist * depth * 0.22;
  vec2 wdir = vec2(cos(spin), sin(spin)) * 1.8;
  float wall = fbm2(wdir + vec2(depth * 1.2, 0.0));
  float rings = 0.5 + 0.5 * sin(depth * 6.2831853);
  float pat = mix(wall, rings, 0.4);

  vec3 col = mix(uColorA, uColorB, pat);
  col = mix(col, uColorC, smoothstep(0.5, 0.95, wall));

  // Radial light-speed streaks. Integer multiple of the angle (16) keeps them
  // seamless across the atan branch cut; they scroll slowly and rush past.
  float streak = pow(0.5 + 0.5 * sin(spin * 16.0 + t * 0.6), 6.0);
  streak *= 0.5 + 0.5 * sin(depth * 3.0); // flicker along depth so they "rush"
  col += uColorC * streak * smoothstep(0.12, 0.7, r) * 0.7;

  // Walls brighten as they near the viewer (large r), darken into the distance.
  col *= smoothstep(0.03, 0.5, r);
  col *= 1.3; // overall luminance lift so the tube reads vividly
  // Bright light at the end of the tunnel.
  col += uColorC * smoothstep(0.18, 0.0, r) * 1.9;

  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.7;
const DEFAULT_TWIST = 1.0;

export class Tunnel extends FullscreenScene {
  readonly id = "tunnel";
  readonly name = "Hyperspace Tunnel";
  readonly description = "An infinite flight down a spiraling light tunnel.";

  readonly parameters = NATIVE_PARAMETERS;

  protected createMaterial(): THREE.ShaderMaterial {
    const p = paletteById("deepspace");
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uTwist: { value: DEFAULT_TWIST },
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
        u.uSpeed.value = remapSpeed(Number(value), 0.7);
        break;
      case "size":
        u.uTwist.value = remapSize(Number(value), 1.0);
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
