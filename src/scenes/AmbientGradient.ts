import * as THREE from "three";
import type { RenderScene } from "../engine/Renderer";

/**
 * Pass-through vertex shader. The Renderer draws a 2x2 plane through an
 * orthographic [-1, 1] frustum, so `position.xy` already spans clip space —
 * we forward the [0, 1] UVs to the fragment stage and emit the vertex as-is.
 */
export const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Fragment shader: a single full-viewport pass that builds slow, awe-inspiring
 * flowing color fields from layered, domain-warped simplex/FBM noise mapped to
 * a smooth multi-stop palette.
 *
 * Cost is deliberately bounded for 60fps: 2D simplex noise (no texture lookups),
 * FBM at 5 octaves, and two warp iterations — no post-processing.
 */
export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform float uSpeed;
uniform vec2  uResolution;
uniform vec3  uColorA; // deep indigo
uniform vec3  uColorB; // magenta
uniform vec3  uColorC; // warm amber

// --- Ashima/Gustavson 2D simplex noise -------------------------------------
// Returns noise in roughly [-1, 1]. Texture-free, branch-light: GPU friendly.
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                          + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Fractional Brownian motion: stacked octaves of simplex noise.
float fbm(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}

void main() {
  // Aspect-corrected coordinates so the field never stretches with the window.
  vec2 uv = vUv;
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) * 2.0;

  float t = uTime * uSpeed;

  // Domain warp: perturb the lookup coordinate by its own noise field twice,
  // which turns plain FBM into slow, organic, aurora-like flow.
  vec2 q = vec2(
    fbm(p + vec2(0.0, 0.0) + 0.15 * t),
    fbm(p + vec2(5.2, 1.3) - 0.12 * t)
  );
  vec2 r = vec2(
    fbm(p + 1.8 * q + vec2(1.7, 9.2) + 0.10 * t),
    fbm(p + 1.8 * q + vec2(8.3, 2.8) - 0.08 * t)
  );

  float f = fbm(p + 2.2 * r);

  // Remap noise from [-1, 1] to a smooth [0, 1] mixing factor.
  float m = clamp(f * 0.5 + 0.5, 0.0, 1.0);

  // Two-segment palette: A -> B over the first half, B -> C over the second.
  vec3 col = mix(uColorA, uColorB, smoothstep(0.0, 0.55, m));
  col = mix(col, uColorC, smoothstep(0.45, 1.0, m));

  // A gentle brightness lift driven by the warp magnitude adds depth without
  // washing the palette out.
  col += 0.06 * length(r);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** Default Aurora palette: deep indigo -> magenta -> warm amber. */
export const DEFAULT_COLORS = {
  a: "#1a1240", // deep indigo
  b: "#c81e8a", // magenta
  c: "#f5a623", // warm amber
} as const;

/** Default flow speed (multiplier on elapsed time). */
export const DEFAULT_SPEED = 0.18;

export interface AmbientGradientOptions {
  /** Flow speed multiplier. Lower is calmer. Defaults to {@link DEFAULT_SPEED}. */
  speed?: number;
  /** Palette colors as CSS hex strings. Falls back to the Aurora defaults. */
  colors?: { a?: string; b?: string; c?: string };
}

/**
 * Ambient flowing-gradient scene — the screensaver's first visual. Owns a single
 * `THREE.ShaderMaterial` rendered on the Renderer's fullscreen quad and advances
 * a `uTime` uniform each frame. Palette and speed are live-tunable through the
 * exposed uniforms.
 */
export class AmbientGradient implements RenderScene {
  readonly material: THREE.ShaderMaterial;

  constructor(options: AmbientGradientOptions = {}) {
    const colors = { ...DEFAULT_COLORS, ...options.colors };
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: options.speed ?? DEFAULT_SPEED },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorA: { value: new THREE.Color(colors.a) },
        uColorB: { value: new THREE.Color(colors.b) },
        uColorC: { value: new THREE.Color(colors.c) },
      },
    });
  }

  /** Advance the flow. Only `uTime` changes per frame. */
  update(elapsed: number): void {
    this.material.uniforms.uTime.value = elapsed;
  }

  /** Keep the aspect ratio correct so the field never stretches. */
  resize(width: number, height: number): void {
    (this.material.uniforms.uResolution.value as THREE.Vector2).set(width, height);
  }

  /** Tune the flow speed at runtime. */
  setSpeed(speed: number): void {
    this.material.uniforms.uSpeed.value = speed;
  }

  /** Release the GPU program + uniforms. */
  dispose(): void {
    this.material.dispose();
  }
}
