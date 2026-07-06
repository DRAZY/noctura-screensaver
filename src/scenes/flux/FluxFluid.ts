import * as THREE from "three";

/**
 * A faithful port of sandydoo/Flux's GPU fluid simulation (github.com/sandydoo/flux,
 * `flux-gl/flux`). This is the engine that makes Flux Drift look ALIVE: a real
 * Jos-Stam "Stable Fluids" solver evolving a 128² velocity field with genuine
 * vortices that swirl and dissipate. The line springs sample this field — the
 * circular waving motion IS the fluid, which is why noise-based fakes never match.
 *
 * Per-frame pipeline (mirrors `flux.rs::compute`):
 *   generate_noise → MacCormack advect (fwd/rev/adjust) → diffuse (viscosity) →
 *   inject noise as a force → divergence → pressure Jacobi (retain) → subtract gradient.
 *
 * All passes are fullscreen-triangle draws into FloatType render targets, ping-ponged.
 */

// ---- Shared fullscreen-triangle vertex shader (clip-space, emits uv) --------
const FS_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ---- 3D simplex noise (Ashima — identical to Flux's generate_noise.frag) -----
const SNOISE3 = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v){
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - 0.5;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0))
                                 + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                                 + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  vec4 j = p - 49.0 * floor(p * (1.0/49.0));
  vec4 x_ = floor(j * (1.0/7.0));
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * (2.0/7.0) + 0.5/7.0 - 1.0;
  vec4 y = y_ * (2.0/7.0) + 0.5/7.0 - 1.0;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0)*2.0 + 1.0;
  vec4 s1 = floor(b1)*2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 g0 = vec3(a0.xy, h.x);
  vec3 g1 = vec3(a0.zw, h.y);
  vec3 g2 = vec3(a1.xy, h.z);
  vec3 g3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
  g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m*m; m = m*m;
  vec4 px = vec4(dot(x0,g0), dot(x1,g1), dot(x2,g2), dot(x3,g3));
  return 42.0 * dot(m, px);
}
`;

// generate_noise.frag — 3 simplex channels summed → a divergence-carrying force field.
const NOISE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 uScale;      // per-channel scale (packed as 3 calls below)
uniform vec3 uChScale;    // scale for ch0,ch1,ch2
uniform vec3 uChMult;     // multiplier for ch0,ch1,ch2
uniform vec3 uChOffset;   // offset for ch0,ch1,ch2 (time-driven)
${SNOISE3}
vec2 makePair(vec3 p){ return vec2(snoise(p), snoise(p + vec3(8.0, -8.0, 0.0))); }
vec2 channel(float scale, float mult, float offset){
  return mult * makePair(vec3(scale * vUv, offset));
}
void main(){
  vec2 n = channel(uChScale.x, uChMult.x, uChOffset.x)
         + channel(uChScale.y, uChMult.y, uChOffset.y)
         + channel(uChScale.z, uChMult.z, uChOffset.z);
  fragColor = vec4(n * 0.45, 0.0, 1.0);
}
`;

// advection.frag — semi-Lagrangian backtrace in TEXEL space (Flux's deliberate
// "don't scale by dx" that gives the slow wriggly look).
const ADVECT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
uniform float amount;       // +dt forward, -dt reverse
uniform float dissipation;
void main(){
  vec2 size = vec2(textureSize(velocityTexture, 0));
  vec2 texelPosition = floor(size * vUv);
  vec2 velocity = texelFetch(velocityTexture, ivec2(texelPosition), 0).xy;
  vec2 advectedPosition = ((texelPosition + 0.5) - amount * velocity) / size;
  float decay = 1.0 + dissipation * amount;
  fragColor = vec4(texture(velocityTexture, advectedPosition).xy / decay, 0.0, 1.0);
}
`;

// adjust_advection.frag — MacCormack correction, clamped to neighbour min/max.
const ADJUST_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
uniform sampler2D forwardTexture;
uniform sampler2D reverseTexture;
uniform float deltaTime;
void main(){
  vec2 size = vec2(textureSize(velocityTexture, 0));
  ivec2 position = ivec2(floor(vUv * size));
  vec2 velocity = texelFetch(velocityTexture, position, 0).xy;
  vec2 sp = (0.5 + floor((vec2(position) + 1.0) - deltaTime * velocity)) / size;
  vec2 L = textureOffset(velocityTexture, sp, ivec2(-1, 0)).xy;
  vec2 R = textureOffset(velocityTexture, sp, ivec2(1, 0)).xy;
  vec2 T = textureOffset(velocityTexture, sp, ivec2(0, 1)).xy;
  vec2 B = textureOffset(velocityTexture, sp, ivec2(0, -1)).xy;
  vec2 lo = min(L, min(R, min(T, B)));
  vec2 hi = max(L, max(R, max(T, B)));
  vec2 forward = texelFetch(forwardTexture, position, 0).xy;
  vec2 reverse = texelFetch(reverseTexture, position, 0).xy;
  vec2 adjusted = forward + 0.5 * (velocity - reverse);
  fragColor = vec4(clamp(adjusted, lo, hi), 0.0, 1.0);
}
`;

// diffuse.frag — viscosity Jacobi.
const DIFFUSE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
uniform float alpha;   // center factor
uniform float rBeta;   // stencil factor
void main(){
  vec2 size = vec2(textureSize(velocityTexture, 0));
  vec2 velocity = texelFetch(velocityTexture, ivec2(floor(size * vUv)), 0).xy;
  vec2 L = textureOffset(velocityTexture, vUv, ivec2(-1, 0)).xy;
  vec2 R = textureOffset(velocityTexture, vUv, ivec2(1, 0)).xy;
  vec2 T = textureOffset(velocityTexture, vUv, ivec2(0, 1)).xy;
  vec2 B = textureOffset(velocityTexture, vUv, ivec2(0, -1)).xy;
  fragColor = vec4(rBeta * (L + R + B + T + alpha * velocity), 0.0, 1.0);
}
`;

// inject_noise.frag — noise added as a force.
const INJECT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
uniform sampler2D noiseTexture;
uniform float deltaTime;
void main(){
  vec2 velocity = texture(velocityTexture, vUv).xy;
  vec2 noise = texture(noiseTexture, vUv).xy;
  fragColor = vec4(velocity + deltaTime * noise, 0.0, 1.0);
}
`;

// divergence.frag
const DIVERGENCE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
void main(){
  float L = textureOffset(velocityTexture, vUv, ivec2(-1, 0)).x;
  float R = textureOffset(velocityTexture, vUv, ivec2(1, 0)).x;
  float T = textureOffset(velocityTexture, vUv, ivec2(0, 1)).y;
  float B = textureOffset(velocityTexture, vUv, ivec2(0, -1)).y;
  fragColor = vec4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}
`;

// solve_pressure.frag — Jacobi (alpha=-1, rBeta=0.25).
const PRESSURE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D pressureTexture;
uniform sampler2D divergenceTexture;
uniform float alpha;
uniform float rBeta;
void main(){
  vec2 size = vec2(textureSize(divergenceTexture, 0));
  ivec2 pos = ivec2(floor(size * vUv));
  float divergence = texelFetch(divergenceTexture, pos, 0).x;
  float L = textureOffset(pressureTexture, vUv, ivec2(-1, 0)).x;
  float R = textureOffset(pressureTexture, vUv, ivec2(1, 0)).x;
  float T = textureOffset(pressureTexture, vUv, ivec2(0, 1)).x;
  float B = textureOffset(pressureTexture, vUv, ivec2(0, -1)).x;
  fragColor = vec4(rBeta * (L + R + B + T + alpha * divergence), 0.0, 0.0, 1.0);
}
`;

// subtract_gradient.frag — projection to divergence-free, with no-slip boundary.
const SUBTRACT_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D velocityTexture;
uniform sampler2D pressureTexture;
uniform vec2 uTexelSize;
void main(){
  float L = textureOffset(pressureTexture, vUv, ivec2(-1, 0)).x;
  float R = textureOffset(pressureTexture, vUv, ivec2(1, 0)).x;
  float T = textureOffset(pressureTexture, vUv, ivec2(0, 1)).x;
  float B = textureOffset(pressureTexture, vUv, ivec2(0, -1)).x;
  vec2 size = vec2(textureSize(velocityTexture, 0));
  vec2 velocity = texelFetch(velocityTexture, ivec2(floor(size * vUv)), 0).xy;
  vec2 boundary = vec2(1.0);
  if (vUv.x < uTexelSize.x || vUv.x > 1.0 - uTexelSize.x) boundary.x = 0.0;
  if (vUv.y < uTexelSize.y || vUv.y > 1.0 - uTexelSize.y) boundary.y = 0.0;
  fragColor = vec4(boundary * (velocity - 0.5 * vec2(R - L, T - B)), 0.0, 1.0);
}
`;

function makeRT(size: number, filter: THREE.MagnificationTextureFilter): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: filter,
    magFilter: filter,
    wrapS: THREE.ClampToEdgeWrapping,
    wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
  });
  return rt;
}

/** Flux fluid tunables (defaults mirror flux `settings.rs`). */
export interface FluidSettings {
  viscosity: number; // default 5
  velocityDissipation: number; // default 0
  diffusionIterations: number; // default 3
  pressureIterations: number; // default 19
  noiseMultiplier: number; // scales injected force (Size/Speed can nudge)
  timestep: number; // fluid timestep (default 1/60)
}

export const DEFAULT_FLUID: FluidSettings = {
  viscosity: 5.0,
  velocityDissipation: 0.0,
  diffusionIterations: 3,
  pressureIterations: 19,
  noiseMultiplier: 1.0,
  timestep: 1 / 60,
};

export class FluxFluid {
  readonly size: number;
  private velA: THREE.WebGLRenderTarget;
  private velB: THREE.WebGLRenderTarget;
  private prsA: THREE.WebGLRenderTarget;
  private prsB: THREE.WebGLRenderTarget;
  private div: THREE.WebGLRenderTarget;
  private noise: THREE.WebGLRenderTarget;
  private fwd: THREE.WebGLRenderTarget;
  private rev: THREE.WebGLRenderTarget;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly quad: THREE.Mesh;
  private readonly mats: Record<string, THREE.RawShaderMaterial>;

  constructor(renderer: THREE.WebGLRenderer, size = 128) {
    this.size = size;
    // Float-texture LINEAR filtering needs OES_texture_float_linear; fall back to
    // NEAREST if the driver lacks it (sim still runs, slightly blockier sampling).
    const linear = renderer.extensions.get("OES_texture_float_linear")
      ? THREE.LinearFilter
      : THREE.NearestFilter;

    this.velA = makeRT(size, linear);
    this.velB = makeRT(size, linear);
    this.prsA = makeRT(size, THREE.NearestFilter);
    this.prsB = makeRT(size, THREE.NearestFilter);
    this.div = makeRT(size, THREE.NearestFilter);
    this.noise = makeRT(size, linear);
    this.fwd = makeRT(size, linear);
    this.rev = makeRT(size, linear);

    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(tri);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    const mk = (frag: string, uniforms: Record<string, THREE.IUniform>) =>
      new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });

    this.mats = {
      noise: mk(NOISE_FRAG, {
        uChScale: { value: new THREE.Vector3(2.5, 15.0, 30.0) },
        uChMult: { value: new THREE.Vector3(1.0, 0.7, 0.5) },
        uChOffset: { value: new THREE.Vector3(0, 0, 0) },
        uScale: { value: new THREE.Vector2(1, 1) },
      }),
      advect: mk(ADVECT_FRAG, { velocityTexture: { value: null }, amount: { value: 0 }, dissipation: { value: 0 } }),
      adjust: mk(ADJUST_FRAG, { velocityTexture: { value: null }, forwardTexture: { value: null }, reverseTexture: { value: null }, deltaTime: { value: 0 } }),
      diffuse: mk(DIFFUSE_FRAG, { velocityTexture: { value: null }, alpha: { value: 0 }, rBeta: { value: 0 } }),
      inject: mk(INJECT_FRAG, { velocityTexture: { value: null }, noiseTexture: { value: null }, deltaTime: { value: 0 } }),
      divergence: mk(DIVERGENCE_FRAG, { velocityTexture: { value: null } }),
      pressure: mk(PRESSURE_FRAG, { pressureTexture: { value: null }, divergenceTexture: { value: null }, alpha: { value: -1 }, rBeta: { value: 0.25 } }),
      subtract: mk(SUBTRACT_FRAG, { velocityTexture: { value: null }, pressureTexture: { value: null }, uTexelSize: { value: new THREE.Vector2(1 / size, 1 / size) } }),
    };
  }

  /** Current velocity field (sample this in the line-spring pass). */
  get velocityTexture(): THREE.Texture {
    return this.velA.texture;
  }

  private blit(renderer: THREE.WebGLRenderer, mat: THREE.RawShaderMaterial, target: THREE.WebGLRenderTarget): void {
    this.quad.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  private swapVel() { const t = this.velA; this.velA = this.velB; this.velB = t; }
  private swapPrs() { const t = this.prsA; this.prsA = this.prsB; this.prsB = t; }

  /** Advance the fluid one step. `time` drives noise evolution. */
  step(renderer: THREE.WebGLRenderer, time: number, s: FluidSettings): void {
    const prevTarget = renderer.getRenderTarget();
    const dt = s.timestep;
    const m = this.mats;

    // 1. Noise force field. Offsets scroll at Flux's FIXED per-frame increments
    // (independent of amplitude) so the field evolves at the reference rate; only
    // uChMult (amplitude) scales with noiseMultiplier.
    (m.noise.uniforms.uChOffset.value as THREE.Vector3).set(
      0.0015 * time * 60,
      0.009 * time * 60,
      0.018 * time * 60,
    );
    (m.noise.uniforms.uChMult.value as THREE.Vector3).set(1.0 * s.noiseMultiplier, 0.7 * s.noiseMultiplier, 0.5 * s.noiseMultiplier);
    this.blit(renderer, m.noise, this.noise);

    // 2. MacCormack advection: forward, reverse, adjust.
    m.advect.uniforms.velocityTexture.value = this.velA.texture;
    m.advect.uniforms.dissipation.value = s.velocityDissipation;
    m.advect.uniforms.amount.value = dt;
    this.blit(renderer, m.advect, this.fwd);
    m.advect.uniforms.amount.value = -dt;
    this.blit(renderer, m.advect, this.rev);
    m.adjust.uniforms.velocityTexture.value = this.velA.texture;
    m.adjust.uniforms.forwardTexture.value = this.fwd.texture;
    m.adjust.uniforms.reverseTexture.value = this.rev.texture;
    m.adjust.uniforms.deltaTime.value = dt;
    this.blit(renderer, m.adjust, this.velB);
    this.swapVel();

    // 3. Diffuse (viscosity Jacobi).
    const center = 1.0 / (s.viscosity * dt);
    const stencil = 1.0 / (4.0 + center);
    m.diffuse.uniforms.alpha.value = center;
    m.diffuse.uniforms.rBeta.value = stencil;
    for (let i = 0; i < s.diffusionIterations; i++) {
      m.diffuse.uniforms.velocityTexture.value = this.velA.texture;
      this.blit(renderer, m.diffuse, this.velB);
      this.swapVel();
    }

    // 4. Inject noise as a force.
    m.inject.uniforms.velocityTexture.value = this.velA.texture;
    m.inject.uniforms.noiseTexture.value = this.noise.texture;
    m.inject.uniforms.deltaTime.value = dt;
    this.blit(renderer, m.inject, this.velB);
    this.swapVel();

    // 5. Divergence.
    m.divergence.uniforms.velocityTexture.value = this.velA.texture;
    this.blit(renderer, m.divergence, this.div);

    // 6. Pressure Jacobi (Retain: keep previous pressure as the initial guess).
    for (let i = 0; i < s.pressureIterations; i++) {
      m.pressure.uniforms.pressureTexture.value = this.prsA.texture;
      m.pressure.uniforms.divergenceTexture.value = this.div.texture;
      this.blit(renderer, m.pressure, this.prsB);
      this.swapPrs();
    }

    // 7. Subtract pressure gradient → divergence-free velocity.
    m.subtract.uniforms.velocityTexture.value = this.velA.texture;
    m.subtract.uniforms.pressureTexture.value = this.prsA.texture;
    this.blit(renderer, m.subtract, this.velB);
    this.swapVel();

    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    for (const rt of [this.velA, this.velB, this.prsA, this.prsB, this.div, this.noise, this.fwd, this.rev]) rt.dispose();
    for (const k of Object.keys(this.mats)) this.mats[k].dispose();
    this.quad.geometry.dispose();
  }
}
