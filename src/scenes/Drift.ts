import * as THREE from "three";
import type { ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS } from "../engine/sceneParams";
import { FluxFluid, DEFAULT_FLUID, type FluidSettings } from "./flux/FluxFluid";

/**
 * Flux Drift — a faithful port of sandydoo/Flux (github.com/sandydoo/flux).
 *
 * ARCHITECTURE (mirrors flux.rs::compute exactly):
 *  - The fluid runs in REAL TIME at fixed 1/60 steps via an accumulator. The slow,
 *    majestic evolution comes from the noise offsets scrolling slowly — NOT from
 *    slowing the simulation down.
 *  - The line springs integrate EVERY FRAME with the raw frame delta (Flux leaves
 *    line animation fps-dependent on purpose; at 60fps it's identical).
 *  - Each line carries 12 floats of persistent state (endpoint, spring velocity,
 *    color, color velocity, width): the ENDPOINT is a damped spring chasing the
 *    fluid, and the COLOR is a second damped spring chasing a velocity-derived
 *    target — that color inertia is a big part of the reference's living look.
 *  - Line geometry lives in *screen* space: the grid is one basepoint every 15
 *    logical px, and line length/width are Flux's exact view_scale/line_scale_factor
 *    products. Blending is (SRC_ALPHA, ONE) — alpha-scaled additive.
 *
 * State is 3 ping-ponged MRT float textures at grid resolution; the update is a
 * fullscreen fragment pass (equivalent to Flux's transform feedback).
 */

const GRID_SPACING = 15; // logical px between basepoints (Flux grid_spacing)
const MAX_FRAME_TIME = 1 / 10; // Flux MAX_FRAME_TIME — clamp long stalls
const FLUID_STEP = 1 / 60; // Flux fluid_timestep AND 1/fluid_frame_rate
const ZOOM = 1.6; // Flux view_scale

// Native-control mapping (parity model). Speed → time rate (0.3 = real-time);
// Intensity → brightness; Density → grid spacing; Size → stroke length/width;
// Style → color mode (default theme = Flux's "Original" velocity coloring).
const DEFAULT_THEME = "aurora";
const NATIVE = { speed: 0.3, intensity: 1.0, density: 0.5, size: 0.85 };

// ---- 3D simplex noise (Ashima), used for per-line variance -------------------
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

// ---- place_lines (Flux place_lines.vert as a fullscreen MRT pass) ------------
// State texel (u,v) = line (u,v). Outputs: 0 = (endpoint, springVel);
// 1 = (color.rgb, smoothed width); 2 = (colorVel.xyz, raw widthBoost = opacity).
const PLACE_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const PLACE_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outEndVel;
layout(location = 1) out vec4 outColorWidth;
layout(location = 2) out vec4 outColorVel;
uniform sampler2D uVelocity;   // fluid velocity field
uniform sampler2D uState0;     // (endpoint.xy, springVel.xy)
uniform sampler2D uState1;     // (color.rgb, width)
uniform sampler2D uState2;     // (colorVel.xyz, widthBoost)
uniform vec2  uBaseSpacing;    // (1/(cols-1), 1/(rows-1)) — basepoint = grid * this
uniform float uLineLength;     // view_scale * line_length * line_scale_factor
uniform float uLineVariance;   // 0.45
uniform vec2  uLineNoiseScale; // 64 * scaling_ratio
uniform float uLineNoiseOffset1;
uniform float uLineNoiseOffset2;
uniform float uLineNoiseBlend;
uniform float uDeltaTime;      // RAW frame delta (Flux: line animation uses frame dt)
uniform int   uColorMode;      // 0 = Original (velocity→RGB), 1 = color wheel
uniform vec3  uWheel[6];
${SNOISE3}

#define TAU 6.283185307179586
vec3 wheelColor(float angle) {
  float slice = TAU / 6.0;
  float rawIndex = mod(angle, TAU) / slice;
  float index = floor(rawIndex);
  float nextIndex = mod(index + 1.0, 6.0);
  return mix(uWheel[int(index)], uWheel[int(nextIndex)], fract(rawIndex));
}

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 basepoint = vec2(tc) * uBaseSpacing;
  vec2 velocity = texture(uVelocity, basepoint).xy;
  vec4 st = texelFetch(uState0, tc, 0);
  vec4 cw = texelFetch(uState1, tc, 0);
  vec4 cv = texelFetch(uState2, tc, 0);

  // Per-line variance from smooth spatial noise (NOT a hash — neighbouring lines
  // share variance, which makes whole neighbourhoods lag/lead together).
  // Crossfade between two noise offsets (Flux): the offset grows until float
  // precision would degrade the simplex lattice, then blends to a fresh offset
  // and swaps — without the blend the swap pops every line's variance at once.
  float noise = snoise(vec3(uLineNoiseScale * basepoint, uLineNoiseOffset1));
  if (uLineNoiseBlend > 0.0) {
    float noise2 = snoise(vec3(uLineNoiseScale * basepoint, uLineNoiseOffset2));
    noise = mix(noise, noise2, uLineNoiseBlend);
  }
  float variance = mix(1.0 - uLineVariance, 1.0, 0.5 + 0.5 * noise);
  float velocityDeltaBoost = mix(3.0, 25.0, 1.0 - variance);
  float momentumBoost = mix(3.0, 5.0, variance);

  // The endpoint spring (Flux exact; NO length cap — Flux has none).
  vec2 newVel = (1.0 - uDeltaTime * momentumBoost) * st.zw
              + (uLineLength * velocity - st.xy) * velocityDeltaBoost * uDeltaTime;
  vec2 newEndpoint = st.xy + uDeltaTime * newVel;

  // Width/opacity ramp: smoothstep(0, 0.4, |velocity|).
  float widthBoost = clamp(2.5 * length(velocity), 0.0, 1.0);
  float width = widthBoost * widthBoost * (3.0 - widthBoost * 2.0);

  // Color target, chased by a second damped spring (this inertia is signature).
  vec3 target;
  if (uColorMode == 0) {
    // "Original": RGB straight from the velocity vector.
    target = vec3(clamp(vec2(1.0, 0.66) * (0.5 + velocity), 0.0, 1.0), 0.5);
  } else {
    target = wheelColor(atan(velocity.x, velocity.y));
  }
  vec3 colorVel = cv.xyz * (1.0 - 3.0 * uDeltaTime) + (target - cw.rgb) * 90.0 * uDeltaTime;
  vec3 color = clamp(cw.rgb + uDeltaTime * colorVel, 0.0, 1.0);

  outEndVel = vec4(newEndpoint, newVel);
  outColorWidth = vec4(color, width);
  outColorVel = vec4(colorVel, width); // wgpu Flux: opacity = smoothstepped widthBoost
}
`;

// ---- Line rendering (Flux line.vert / line.frag) ------------------------------
const LINE_VERT = /* glsl */ `
// ShaderMaterial(GLSL3) injects: in vec3 position; + matrices (unused — clip space).
in vec2 aCorner;    // quad template: x in [-0.5,0.5] (width), y in [0,1] (base→tip)
in vec2 aGrid;      // grid cell (u, v) — same for the 4 verts of a line
uniform sampler2D uState0;
uniform sampler2D uState1;
uniform sampler2D uState2;
uniform vec2  uBaseSpacing;
uniform float uAspect;
uniform float uZoom;
uniform float uLineWidth;    // view_scale * line_width * line_scale_factor
uniform float uBeginOffset;  // Flux line_begin_offset (0.4)
uniform float uGlow;
out vec2  vVertex;
out vec4  vColor;
out float vLineOffset;

void main() {
  ivec2 tc = ivec2(aGrid);
  vec2 basepoint = aGrid * uBaseSpacing;
  vec2 endpoint = texelFetch(uState0, tc, 0).xy;
  vec4 cw = texelFetch(uState1, tc, 0);
  float widthBoost = texelFetch(uState2, tc, 0).w;

  vec2 xBasis = vec2(-endpoint.y, endpoint.x);
  xBasis /= length(xBasis) + 0.0001;

  vec2 pt = vec2(uAspect, 1.0) * uZoom * (basepoint * 2.0 - 1.0)
          + endpoint * aCorner.y
          + uLineWidth * cw.a * xBasis * aCorner.x;
  pt.x /= uAspect;
  gl_Position = vec4(pt, 0.0, 1.0);

  vVertex = aCorner;
  vColor = vec4(cw.rgb * uGlow, widthBoost);
  float shortLineBoost = 1.0 + (uLineWidth * cw.a) / (length(endpoint) + 1e-6);
  vLineOffset = uBeginOffset / shortLineBoost;
}
`;
const LINE_FRAG = /* glsl */ `
precision highp float;
in vec2  vVertex;
in vec4  vColor;
in float vLineOffset;
out vec4 fragColor;
void main() {
  float fade = smoothstep(vLineOffset, 1.0, vVertex.y);
  float xOffset = abs(vVertex.x);
  float smoothEdges = 1.0 - smoothstep(0.5 - fwidth(xOffset), 0.5, xOffset);
  fragColor = vec4(vColor.rgb, vColor.a * fade * smoothEdges);
}
`;

// ---- Endpoint rendering (Flux endpoint.vert / endpoint.frag) ------------------
// A disc at the line head. The top half draws at full opacity; the bottom half
// (overlapping the line) gets a compensated color so the SRC_ALPHA/ONE blend of
// disc-over-line exactly matches the top half. Verbatim Flux math.
const ENDPOINT_VERT = /* glsl */ `
in vec2 aCorner;    // quad corner in [-1,1]^2
in vec2 aGrid;
uniform sampler2D uState0;
uniform sampler2D uState1;
uniform sampler2D uState2;
uniform vec2  uBaseSpacing;
uniform float uAspect;
uniform float uZoom;
uniform float uLineWidth;
uniform float uGlow;
out vec2 vVertex;
out vec2 vMidpointVector;
out vec4 vTopColor;
out vec4 vBottomColor;

void main() {
  ivec2 tc = ivec2(aGrid);
  vec2 basepoint = aGrid * uBaseSpacing;
  vec2 endpoint = texelFetch(uState0, tc, 0).xy;
  vec4 cw = texelFetch(uState1, tc, 0);
  float widthBoost = texelFetch(uState2, tc, 0).w;

  vec2 pt = vec2(uAspect, 1.0) * uZoom * (basepoint * 2.0 - 1.0)
          + endpoint
          + 0.5 * uLineWidth * cw.a * aCorner;
  pt.x /= uAspect;
  gl_Position = vec4(pt, 0.0, 1.0);

  vVertex = aCorner;
  // Rotate the endpoint vector 90° — used for the which-side test in the fragment.
  vMidpointVector = vec2(endpoint.y, -endpoint.x);

  vec3 rgb = cw.rgb * uGlow;
  vTopColor = vec4(rgb, 1.0);
  // Compensate for the line already drawn underneath (premultiplied reverse-blend).
  vec3 premultipliedLineColor = rgb * widthBoost;
  vBottomColor = vec4(rgb - premultipliedLineColor, 1.0);
}
`;
const ENDPOINT_FRAG = /* glsl */ `
precision highp float;
in vec2 vVertex;
in vec2 vMidpointVector;
in vec4 vTopColor;
in vec4 vBottomColor;
out vec4 fragColor;
void main() {
  vec4 color = vBottomColor;
  float side
    = (vVertex.x - vMidpointVector.x) * (-vMidpointVector.y)
    - (vVertex.y - vMidpointVector.y) * (-vMidpointVector.x);
  if (side > 0.0) color = vTopColor;

  float dist = length(vVertex);
  float smoothEdges = 1.0 - smoothstep(1.0 - fwidth(dist), 1.0, dist);
  fragColor = vec4(color.rgb, color.a * smoothEdges);
}
`;

// ---- Final output encode ------------------------------------------------------
// The wgpu Flux accumulates lines in LINEAR space and lets the sRGB swapchain
// encode the result; a plain WebGL canvas has no such encode, so additive piles
// of blades come out darker and pinker. We reproduce it: lines accumulate into a
// linear float target, then this pass applies the exact linear→sRGB transfer.
const ENCODE_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const ENCODE_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uAcc;
vec3 srgb(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
void main(){
  fragColor = vec4(srgb(texture(uAcc, vUv).rgb), 1.0);
}
`;

// Debug: view the raw fluid velocity field as colour (?fluxdebug=1).
const DEBUG_VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const DEBUG_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVelocity;
void main(){
  vec2 v = texture(uVelocity, vUv).xy;
  fragColor = vec4(0.5 + 3.0 * v, 0.5, 1.0);
}
`;

/** Flux's line_scale_factor: normalizes pixel-unit line length/width to clip. */
function lineScaleFactor(w: number, h: number): number {
  const p = h / w; // 1/aspect
  return 1.0 / Math.min((1.0 - p) * w + p * h, 2000.0);
}

/** Flux's clamp_logical_size: upscale tiny viewports to a working minimum. */
function clampLogicalSize(w: number, h: number): [number, number] {
  const scale = Math.max(800 / w, 800 / h, 1);
  return [Math.floor(w * scale), Math.floor(h * scale)];
}

/** Alpha-scaled additive blending — Flux's (SRC_ALPHA, ONE, ONE, ONE). */
function fluxBlending(mat: THREE.ShaderMaterial): void {
  mat.blending = THREE.CustomBlending;
  mat.blendSrc = THREE.SrcAlphaFactor;
  mat.blendDst = THREE.OneFactor;
  mat.blendSrcAlpha = THREE.OneFactor;
  mat.blendDstAlpha = THREE.OneFactor;
}

function makeStateRT(cols: number, rows: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(cols, rows, {
    count: 3, // MRT: (endpoint,vel) + (color,width) + (colorVel,widthBoost)
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
}

export class Drift implements Scene {
  readonly id = "drift";
  readonly name = "Flux Drift";
  readonly description = "Lines of light woven through a living fluid — the macOS Drift / Flux look.";
  readonly parameters = NATIVE_PARAMETERS;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private renderer!: THREE.WebGLRenderer;

  private fluid!: FluxFluid;
  private fluidSettings: FluidSettings = { ...DEFAULT_FLUID };

  // Line grid (screen-size dependent) + MRT state ping-pong.
  private cols = 2;
  private rows = 2;
  private stateA!: THREE.WebGLRenderTarget;
  private stateB!: THREE.WebGLRenderTarget;
  private placeMat!: THREE.RawShaderMaterial;
  private readonly placeScene = new THREE.Scene();
  private placeQuad!: THREE.Mesh;

  private lineMat!: THREE.ShaderMaterial;
  private lineMesh!: THREE.Mesh;
  private endpointMat!: THREE.ShaderMaterial;
  private endpointMesh!: THREE.Mesh;

  // Linear accumulation target + sRGB encode pass (see ENCODE_FRAG).
  private accTarget: THREE.WebGLRenderTarget | null = null;
  private encodeMat!: THREE.RawShaderMaterial;
  private readonly encodeScene = new THREE.Scene();

  private debugMat: THREE.RawShaderMaterial | null = null;
  private readonly debugScene = new THREE.Scene();
  private readonly debug =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("fluxdebug") === "1";

  // Native-control state.
  private speed = NATIVE.speed;
  private intensity = NATIVE.intensity;
  private size = NATIVE.size;
  private density = NATIVE.density;
  private theme = DEFAULT_THEME;
  private width = 1;
  private height = 1;

  // Flux timing state (flux.rs::compute).
  private elapsedTime = 0;
  private fluidFrameTime = 0;
  private warmupLeft = 60; // fluid steps, amortized (Flux starts from rest; this just skips the first dark second)

  // Line-noise offset state (drawer.rs LineUniforms::tick — ticks once per frame).
  private lineNoiseOffset1 = 0;
  private lineNoiseOffset2 = 0;
  private lineNoiseBlendFactor = 0;

  init(ctx: SceneContext): void {
    this.renderer = ctx.renderer;
    this.width = Math.max(ctx.width, 1);
    this.height = Math.max(ctx.height, 1);
    this.fluid = new FluxFluid(this.renderer, 128);

    // place_lines pass (fullscreen triangle over the grid-sized MRT target).
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.placeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: PLACE_VERT,
      fragmentShader: PLACE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uVelocity: { value: null },
        uState0: { value: null },
        uState1: { value: null },
        uState2: { value: null },
        uBaseSpacing: { value: new THREE.Vector2(1, 1) },
        uLineLength: { value: 0 },
        uLineVariance: { value: 0.55 },
        uLineNoiseScale: { value: new THREE.Vector2(64, 64) },
        uLineNoiseOffset1: { value: 0 },
        uLineNoiseOffset2: { value: 0 },
        uLineNoiseBlend: { value: 0 },
        uDeltaTime: { value: 0 },
        uColorMode: { value: 0 },
        uWheel: { value: [...Array(6)].map(() => new THREE.Vector3(1, 1, 1)) },
      },
    });
    this.placeQuad = new THREE.Mesh(tri, this.placeMat);
    this.placeQuad.frustumCulled = false;
    this.placeScene.add(this.placeQuad);

    const sharedDrawUniforms = () => ({
      uState0: { value: null as THREE.Texture | null },
      uState1: { value: null as THREE.Texture | null },
      uState2: { value: null as THREE.Texture | null },
      uBaseSpacing: { value: new THREE.Vector2(1, 1) },
      uAspect: { value: 1 },
      uZoom: { value: ZOOM },
      uLineWidth: { value: 0 },
      uGlow: { value: 1 },
    });

    this.lineMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // quads flip winding with flow direction — never cull
      uniforms: { ...sharedDrawUniforms(), uBeginOffset: { value: 0.4 } },
    });
    fluxBlending(this.lineMat);

    this.endpointMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ENDPOINT_VERT,
      fragmentShader: ENDPOINT_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: sharedDrawUniforms(),
    });
    fluxBlending(this.endpointMat);

    this.encodeMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: ENCODE_VERT,
      fragmentShader: ENCODE_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: { uAcc: { value: null } },
    });
    const eq = new THREE.Mesh(tri.clone(), this.encodeMat);
    eq.frustumCulled = false;
    this.encodeScene.add(eq);

    this.rebuildGrid(); // builds meshes, state targets, and screen-derived uniforms
    this.applyControls();

    if (this.debug) {
      this.debugMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: DEBUG_VERT, fragmentShader: DEBUG_FRAG,
        depthTest: false, depthWrite: false,
        uniforms: { uVelocity: { value: this.fluid.velocityTexture } },
      });
      const dq = new THREE.Mesh(tri.clone(), this.debugMat);
      dq.frustumCulled = false;
      this.debugScene.add(dq);
    }
  }

  /**
   * (Re)build the basepoint grid from the logical viewport (Flux Grid::new):
   * one line every `spacing` logical px; basepoints span [0,1]² inclusive.
   * Rebuilt on resize and on Density changes (Density scales the spacing).
   */
  private rebuildGrid(): void {
    const [lw, lh] = clampLogicalSize(this.width, this.height);
    const spacing = GRID_SPACING / (0.5 + this.density); // density 0.5 (default) → Flux's 15
    const cols0 = Math.max(1, Math.floor(lw / spacing));
    const rows0 = Math.max(1, Math.floor((lh / lw) * cols0));
    this.cols = cols0 + 1;
    this.rows = rows0 + 1;
    const count = this.cols * this.rows;

    // State targets (fresh state = lines grow in from rest, like Flux startup).
    this.stateA?.dispose();
    this.stateB?.dispose();
    this.stateA = makeStateRT(this.cols, this.rows);
    this.stateB = makeStateRT(this.cols, this.rows);

    // Non-instanced indexed geometry (the proven-rendering structure): 4 real
    // vertices per line + 6 indices, each vertex tagged with grid cell + corner.
    const lineCornerPat = [-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1];
    const endCornerPat = [-1, -1, 1, -1, -1, 1, 1, 1];
    const N = count * 4;
    const position = new Float32Array(N * 3); // dummy (ShaderMaterial requires it)
    const aLineCorner = new Float32Array(N * 2);
    const aEndCorner = new Float32Array(N * 2);
    const aGrid = new Float32Array(N * 2);
    const indices = new Uint32Array(count * 6);
    let i = 0;
    for (let v = 0; v < this.rows; v++) {
      for (let u = 0; u < this.cols; u++, i++) {
        const base = i * 4;
        for (let k = 0; k < 4; k++) {
          const vi = base + k;
          aLineCorner[vi * 2] = lineCornerPat[k * 2];
          aLineCorner[vi * 2 + 1] = lineCornerPat[k * 2 + 1];
          aEndCorner[vi * 2] = endCornerPat[k * 2];
          aEndCorner[vi * 2 + 1] = endCornerPat[k * 2 + 1];
          aGrid[vi * 2] = u;
          aGrid[vi * 2 + 1] = v;
        }
        const ii = i * 6;
        indices[ii] = base; indices[ii + 1] = base + 1; indices[ii + 2] = base + 2;
        indices[ii + 3] = base + 2; indices[ii + 4] = base + 1; indices[ii + 5] = base + 3;
      }
    }

    const posAttr = new THREE.BufferAttribute(position, 3);
    const gridAttr = new THREE.BufferAttribute(aGrid, 2);
    const indexAttr = new THREE.BufferAttribute(indices, 1);

    const lineGeo = new THREE.BufferGeometry();
    lineGeo.setAttribute("position", posAttr);
    lineGeo.setAttribute("aCorner", new THREE.BufferAttribute(aLineCorner, 2));
    lineGeo.setAttribute("aGrid", gridAttr);
    lineGeo.setIndex(indexAttr);

    const endGeo = new THREE.BufferGeometry();
    endGeo.setAttribute("position", posAttr);
    endGeo.setAttribute("aCorner", new THREE.BufferAttribute(aEndCorner, 2));
    endGeo.setAttribute("aGrid", gridAttr);
    endGeo.setIndex(indexAttr);

    if (this.lineMesh) {
      this.scene.remove(this.lineMesh);
      this.lineMesh.geometry.dispose();
    }
    if (this.endpointMesh) {
      this.scene.remove(this.endpointMesh);
      this.endpointMesh.geometry.dispose();
    }
    this.lineMesh = new THREE.Mesh(lineGeo, this.lineMat);
    this.lineMesh.frustumCulled = false;
    this.scene.add(this.lineMesh);
    this.endpointMesh = new THREE.Mesh(endGeo, this.endpointMat);
    this.endpointMesh.frustumCulled = false;
    this.scene.add(this.endpointMesh); // after lines → draws on top

    // Screen-derived uniforms (Flux LineUniforms::new).
    const lsf = lineScaleFactor(lw, lh);
    const aspect = lw / lh;
    const sizeF = 1.0 + 0.5 * (this.size - NATIVE.size); // Size control nudges stroke scale
    const uLineWidth = ZOOM * 9.0 * lsf * sizeF;
    const uLineLength = ZOOM * 450.0 * lsf * sizeF;
    const baseSpacing = new THREE.Vector2(1 / cols0, 1 / rows0);
    const scalingRatio = new THREE.Vector2(Math.max(this.cols / 171, 1), Math.max(this.rows / 171, 1));

    const pu = this.placeMat.uniforms;
    pu.uBaseSpacing.value = baseSpacing;
    pu.uLineLength.value = uLineLength;
    (pu.uLineNoiseScale.value as THREE.Vector2).set(64 * scalingRatio.x, 64 * scalingRatio.y);
    for (const m of [this.lineMat, this.endpointMat]) {
      m.uniforms.uBaseSpacing.value = baseSpacing;
      m.uniforms.uAspect.value = aspect;
      m.uniforms.uLineWidth.value = uLineWidth;
    }
  }

  /** Map the native controls onto uniforms (defaults = Flux's exact defaults). */
  private applyControls(): void {
    this.fluidSettings.noiseMultiplier = 1.0; // faithful field energy
    const glow = 0.5 + 0.5 * this.intensity; // 1.0 (faithful) at default intensity
    this.lineMat.uniforms.uGlow.value = glow;
    this.endpointMat.uniforms.uGlow.value = glow;

    // Style: default theme = Flux "Original" (velocity→RGB); other themes drive
    // Flux's 6-slot color wheel from the theme's three colors.
    const pu = this.placeMat.uniforms;
    if (this.theme === DEFAULT_THEME) {
      pu.uColorMode.value = 0;
    } else {
      pu.uColorMode.value = 1;
      const p = paletteById(this.theme);
      const wheel = pu.uWheel.value as THREE.Vector3[];
      const colors = [hexToColor(p.a), hexToColor(p.b), hexToColor(p.c)];
      for (let i = 0; i < 6; i++) {
        const c = colors[i % 3];
        wheel[i].set(c.r, c.g, c.b);
      }
    }
  }

  /** Flux drawer.rs LineUniforms::tick — line-variance noise scroll, per frame. */
  private tickLineNoise(): void {
    const BLEND_THRESHOLD = 4.0;
    const BASE_OFFSET = 0.0015;
    const perturb = 1.0 + 0.2 * Math.sin(0.01 * this.elapsedTime * Math.PI * 2);
    const offset = BASE_OFFSET * perturb;
    this.lineNoiseOffset1 += offset;
    if (this.lineNoiseOffset1 > BLEND_THRESHOLD) {
      this.lineNoiseOffset2 += offset;
      this.lineNoiseBlendFactor += BASE_OFFSET;
    }
    if (this.lineNoiseBlendFactor > 1.0) {
      this.lineNoiseOffset1 = this.lineNoiseOffset2;
      this.lineNoiseOffset2 = 0;
      this.lineNoiseBlendFactor = 0;
    }
  }

  update(_time: number, delta: number): void {
    // Flux flux.rs::compute — REAL time, clamped, with the Speed control scaling
    // the rate (default 0.3 = 1× real-time, exactly the reference).
    const speedScale = this.speed / NATIVE.speed;
    const dt = Math.min(Math.max(delta, 0), MAX_FRAME_TIME) * speedScale;
    if (dt <= 0) return;
    this.elapsedTime += dt;
    if (this.elapsedTime >= 1000) this.elapsedTime -= 1000; // MAX_ELAPSED_TIME wrap
    this.fluidFrameTime += dt;

    // Amortized warm-up: a few extra fluid steps per frame at startup so the field
    // develops in ~1s instead of the reference's dark first seconds. Bounded per
    // frame — never a burst that could stall a slow GPU.
    if (this.warmupLeft > 0) {
      const n = Math.min(this.warmupLeft, 8);
      for (let i = 0; i < n; i++) {
        this.fluid.step(this.renderer, this.elapsedTime, this.fluidSettings);
      }
      this.warmupLeft -= n;
    }

    // Fluid: fixed 1/60 steps in real time (an accumulator, NOT one step per frame).
    this.fluidSettings.timestep = FLUID_STEP;
    let steps = 0;
    while (this.fluidFrameTime >= FLUID_STEP && steps < 6) {
      this.fluid.step(this.renderer, this.elapsedTime, this.fluidSettings);
      this.fluidFrameTime -= FLUID_STEP;
      steps += 1;
    }
    if (this.fluidFrameTime > FLUID_STEP) this.fluidFrameTime = FLUID_STEP; // drop backlog after a stall

    // Lines: place with the RAW frame delta (Flux's line animation timing).
    this.tickLineNoise();
    const pu = this.placeMat.uniforms;
    pu.uDeltaTime.value = dt;
    pu.uLineNoiseOffset1.value = this.lineNoiseOffset1;
    pu.uLineNoiseOffset2.value = this.lineNoiseOffset2;
    pu.uLineNoiseBlend.value = this.lineNoiseBlendFactor;
    pu.uVelocity.value = this.fluid.velocityTexture;
    pu.uState0.value = this.stateA.textures[0];
    pu.uState1.value = this.stateA.textures[1];
    pu.uState2.value = this.stateA.textures[2];
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.stateB);
    this.renderer.render(this.placeScene, this.camera);
    const t = this.stateA; this.stateA = this.stateB; this.stateB = t;
    this.renderer.setRenderTarget(prev);

    // Point the draw materials at the fresh state.
    for (const m of [this.lineMat, this.endpointMat]) {
      m.uniforms.uState0.value = this.stateA.textures[0];
      m.uniforms.uState1.value = this.stateA.textures[1];
      m.uniforms.uState2.value = this.stateA.textures[2];
    }
    if (this.debugMat) this.debugMat.uniforms.uVelocity.value = this.fluid.velocityTexture;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    if (this.debug && this.debugMat) {
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 1);
      renderer.clear();
      renderer.render(this.debugScene, this.camera);
      return;
    }

    // Accumulate lines in LINEAR space at output resolution, then sRGB-encode to
    // the real target (matches the wgpu Flux swapchain behavior — see ENCODE_FRAG).
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const w = target ? target.width : size.x;
    const h = target ? target.height : size.y;
    if (!this.accTarget || this.accTarget.width !== w || this.accTarget.height !== h) {
      this.accTarget?.dispose();
      this.accTarget = new THREE.WebGLRenderTarget(w, h, {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        minFilter: THREE.NearestFilter,
        magFilter: THREE.NearestFilter,
        depthBuffer: false,
        stencilBuffer: false,
      });
    }
    renderer.setRenderTarget(this.accTarget);
    renderer.setClearColor(0x000000, 1); // Flux clears to pure black
    renderer.clear();
    renderer.render(this.scene, this.camera);

    this.encodeMat.uniforms.uAcc.value = this.accTarget.texture;
    renderer.setRenderTarget(target);
    renderer.render(this.encodeScene, this.camera);
  }

  resize(width: number, height: number): void {
    this.width = Math.max(width, 1);
    this.height = Math.max(height, 1);
    this.rebuildGrid();
  }

  setParameter(id: string, value: ParameterValue): void {
    switch (id) {
      case "speed":
        this.speed = Number(value);
        break;
      case "intensity":
        this.intensity = Number(value);
        this.applyControls();
        break;
      case "density":
        this.density = Number(value);
        this.rebuildGrid();
        break;
      case "size":
        this.size = Number(value);
        this.rebuildGrid(); // stroke scale is folded into the screen-derived uniforms
        break;
      case "theme":
        this.theme = String(value);
        this.applyControls();
        break;
    }
  }

  dispose(): void {
    this.accTarget?.dispose();
    this.encodeMat?.dispose();
    this.fluid?.dispose();
    this.stateA?.dispose();
    this.stateB?.dispose();
    this.placeMat?.dispose();
    this.placeQuad?.geometry.dispose();
    this.lineMat?.dispose();
    this.lineMesh?.geometry.dispose();
    this.endpointMat?.dispose();
    this.endpointMesh?.geometry.dispose();
    this.debugMat?.dispose();
    if (this.lineMesh) this.scene.remove(this.lineMesh);
    if (this.endpointMesh) this.scene.remove(this.endpointMesh);
  }
}
