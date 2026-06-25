import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { DITHER, FBM_2D, SIMPLEX_2D } from "../engine/shaders/noise.glsl";
import { FullscreenScene } from "./FullscreenScene";

/**
 * A black hole with a swirling accretion disk and a bright photon ring around a
 * dark event horizon. The disk is FBM noise sheared in polar coordinates so it
 * appears to orbit; a starfield backdrop and soft bloom sell the scale. Pure
 * "awe" piece — the kind of visual that sells a screensaver app.
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
uniform float uSize;
uniform vec2  uResolution;
uniform vec3  uColorInner;
uniform vec3  uColorOuter;

${SIMPLEX_2D}
${FBM_2D}
${DITHER}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float r = length(p);
  float a = atan(p.y, p.x);
  float t = uTime * uSpeed;

  float horizon = 0.13 * uSize;     // event-horizon radius
  float ringR  = 0.165 * uSize;     // photon ring radius

  // Differential rotation: inner material orbits faster than outer.
  float swirl = a + t * (0.6 / max(r, 0.05));
  // Sample the disk noise on a CIRCLE (cos/sin of the angle) so it is periodic
  // in angle — otherwise the atan() branch cut at ±PI leaves a hard seam running
  // out along the -X axis. The radial term adds the orbiting streak detail.
  vec2 swdir = vec2(cos(swirl), sin(swirl)) * 1.6;
  float disk = fbm2(swdir + vec2(r * 6.0 - t * 0.5, 0.0));
  disk = pow(clamp(disk * 0.5 + 0.5, 0.0, 1.0), 1.5);

  // Disk lives in an annulus; fade in past the horizon, out toward the edge.
  float band = smoothstep(horizon, ringR * 1.4, r) * (1.0 - smoothstep(0.5 * uSize, 1.1 * uSize, r));
  vec3 diskCol = mix(uColorOuter, uColorInner, disk) * disk * band * 2.2;

  // Bright photon ring hugging the event horizon.
  float ring = exp(-pow((r - ringR) * 26.0, 2.0));
  diskCol += uColorInner * ring * 1.6;

  // Pull everything to black inside the event horizon (0 inside, 1 outside).
  float hole = smoothstep(horizon * 0.75, horizon, r);
  vec3 col = diskCol * hole;

  // Faint star backdrop, lensed (compressed) near the hole.
  float lens = 1.0 - exp(-r * 3.0);
  float stars = step(0.997, snoise(p * 90.0 * lens));
  col += vec3(stars) * 0.5 * hole;

  gl_FragColor = vec4(col + dither(gl_FragCoord.xy), 1.0);
}
`;

const DEFAULT_SPEED = 0.5;
const DEFAULT_SIZE = 1.6;

export class BlackHole extends FullscreenScene {
  readonly id = "black-hole";
  readonly name = "Black Hole";
  readonly description = "A glowing accretion disk swirling into the void.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.1, max: 1.5, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "size", label: "Size", min: 1.0, max: 2.4, step: 0.05, default: DEFAULT_SIZE },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "ember" },
    { kind: "color", id: "colorInner", label: "Inner", default: "#fff1c2" },
    { kind: "color", id: "colorOuter", label: "Outer", default: "#c73b0a" },
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
        uSize: { value: DEFAULT_SIZE },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorInner: { value: hexToColor("#fff1c2") },
        uColorOuter: { value: hexToColor("#c73b0a") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "size":
        u.uSize.value = Number(value);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorInner.value as THREE.Color).set(p.c);
        (u.uColorOuter.value as THREE.Color).set(p.b);
        break;
      }
      case "colorInner":
        (u.uColorInner.value as THREE.Color).set(String(value));
        break;
      case "colorOuter":
        (u.uColorOuter.value as THREE.Color).set(String(value));
        break;
    }
  }
}
