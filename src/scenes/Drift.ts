import * as THREE from "three";
import type { ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS } from "../engine/sceneParams";
import { FluxFluid, DEFAULT_FLUID, type FluidSettings } from "./flux/FluxFluid";

/**
 * Flux Drift — a faithful port of sandydoo/Flux (github.com/sandydoo/flux).
 *
 * The motion that makes it come alive is a REAL fluid simulation, not noise: a
 * 128² Jos-Stam "Stable Fluids" solver ({@link FluxFluid}) evolves a velocity
 * field with genuine vortices that swirl and dissipate, and thousands of line
 * springs chase that fluid velocity. Each line's endpoint is a damped spring
 * (Flux's exact `place_lines.vert` equation) that lags and overshoots the flow —
 * so the lines wave in circular, inertial arcs around the fluid's vortices.
 *
 * Everything runs on the GPU: the fluid passes, the per-line spring update (a
 * ping-pong state texture), and instanced quad rendering. No CPU per-frame work
 * beyond a handful of uniform writes.
 */

// Line grid: one line per cell. GX×GY lines (~Flux grid_spacing 15px at 1080p).
// GX doubles as the line-state texture width so texel (gx,gy) ↔ line (gx,gy).
const GX = 128;
const GY = 72;
const NUM_LINES = GX * GY; // 9,216 — matches Flux's grid_spacing 15px (the good-motion density)

// ---- Line-spring update (Flux place_lines.vert, run as a fullscreen pass) -----
const SPRING_VERT = /* glsl */ `
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const SPRING_FRAG = /* glsl */ `
precision highp float;
out vec4 fragColor;
uniform sampler2D uVelocity;   // fluid velocity field
uniform sampler2D uState;      // previous line state: (endpoint.xy, springVel.xy)
uniform vec2  uGridSize;       // (GX, GY)
uniform float uLineLength;     // Flux line_length uniform ≈ 0.6
uniform float uLineVariance;   // Flux line_variance (0.45)
uniform float uVelGain;        // rescales weak (slowed) velocity to Flux's ~0.1 magnitude
uniform float uDeltaTime;

// cheap hash for per-line variance (stands in for Flux's per-line snoise, [0,1])
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

void main() {
  ivec2 tc = ivec2(gl_FragCoord.xy);
  vec2 grid = vec2(tc);
  vec2 basepoint = (grid + 0.5) / uGridSize;

  // Slowing the sim (TIME_SCALE) weakens the raw velocity; uVelGain rescales it so
  // lines see Flux's ~0.1 magnitude (correct length + width) WITHOUT changing the
  // fluid's evolution rate. A pure render/spring gain — decoupled from motion speed.
  vec2 velocity = texture(uVelocity, basepoint).xy * uVelGain;
  vec4 st = texelFetch(uState, tc, 0);
  vec2 endpoint = st.xy;
  vec2 springVel = st.zw;

  // Flux's EXACT damped-spring constants (place_lines.vert). These are calibrated
  // for velocity ~0.1 and dt 1/60 — which is exactly what the fluid now produces
  // (running at the real timestep, not a slowed one). variance in [0,1].
  float variance = mix(1.0 - uLineVariance, 1.0, hash(grid));
  float velocityDeltaBoost = mix(3.0, 25.0, 1.0 - variance);
  float momentumBoost = mix(3.0, 5.0, variance);

  vec2 newVel = (1.0 - uDeltaTime * momentumBoost) * springVel
              + (uLineLength * velocity - endpoint) * velocityDeltaBoost * uDeltaTime;
  vec2 newEndpoint = endpoint + uDeltaTime * newVel;

  // Generous blow-up guard only (Flux has no cap); normal endpoints stay well under this.
  float len = length(newEndpoint);
  if (len > 0.6) newEndpoint *= 0.6 / len;

  fragColor = vec4(newEndpoint, newVel);
}
`;

// ---- Instanced line rendering (Flux line.vert / line.frag) -------------------
const LINE_VERT = /* glsl */ `
// ShaderMaterial(GLSL3) injects: in vec3 position; + matrices (unused — we emit clip space).
// Non-instanced: 4 real vertices per line, each carrying its grid cell + corner.
in vec2 aCorner;    // quad template: x in [-0.5,0.5] (width), y in [0,1] (base→tip)
in vec2 aGrid;      // grid cell (gx, gy) — same for the 4 verts of a line
uniform sampler2D uState;
uniform sampler2D uVelocity;
uniform vec2  uGridSize;
uniform float uAspect;
uniform float uZoom;
uniform float uLineWidth;
uniform float uBeginOffset;
uniform float uVelGain;   // match the spring's velocity rescale (width/brightness)
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform float uTime;
out vec2  vVertex;
out vec3  vColor;
out float vAlpha;
out float vBeginOffset;

vec3 palCyc(float x){
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  vec2 stateUv = (aGrid + 0.5) / uGridSize;      // texel-centre of this line's state
  vec2 basepoint = stateUv;                       // grid cell centre in [0,1]^2
  vec2 endpoint = texture(uState, stateUv).xy;    // spring endpoint (Nearest-filtered state)
  vec2 fluidVel = texture(uVelocity, basepoint).xy * uVelGain; // rescaled to Flux's ~0.1

  // Flux's EXACT width/opacity ramp (place_lines.vert widthBoost). Faster flow →
  // wider AND longer stroke, so the length:width ratio stays ~constant (thin blades);
  // calm flow → nearly invisible. This is what auto-maintains the blade aspect.
  float wb = clamp(2.5 * length(fluidVel), 0.0, 1.0);
  float lineWidth = wb * wb * (3.0 - 2.0 * wb);

  vec2 xBasis = vec2(-endpoint.y, endpoint.x);
  xBasis /= length(xBasis) + 1e-4;
  vec2 point = vec2(uAspect, 1.0) * uZoom * (basepoint * 2.0 - 1.0)
             + endpoint * aCorner.y
             + uLineWidth * lineWidth * xBasis * aCorner.x;
  point.x /= uAspect;
  gl_Position = vec4(point, 0.0, 1.0);

  vVertex = aCorner;
  float shortBoost = 1.0 + (uLineWidth * lineWidth) / (length(endpoint) + 1e-4);
  vBeginOffset = uBeginOffset / shortBoost;
  // Colour zone from flow direction + basepoint, cycled through the Style palette.
  float angle = atan(fluidVel.y, fluidVel.x) / 6.28318 + 0.5;
  vColor = palCyc(angle + 0.35 * (basepoint.x + basepoint.y) + 0.01 * uTime);
  vAlpha = wb;
}
`;
const LINE_FRAG = /* glsl */ `
precision highp float;
in vec2  vVertex;
in vec3  vColor;
in float vAlpha;
in float vBeginOffset;
out vec4 fragColor;
uniform float uGlow;
void main() {
  float fade = smoothstep(vBeginOffset, 1.0, vVertex.y);      // tail dark → head bright
  float xo = abs(vVertex.x);
  float edge = 1.0 - smoothstep(0.5 - fwidth(xo), 0.5, xo);   // AA across width
  float a = vAlpha * fade * edge;
  if (a <= 0.0009) discard;
  fragColor = vec4(vColor * a * uGlow, 1.0);                  // additive
}
`;

// ---- Rounded endpoint caps (Flux endpoint.vert/endpoint.frag) ----------------
// Flux draws a small antialiased disc at each line's HEAD so blades end in a
// rounded tip instead of a hard rectangle — a signature detail of the reference.
// We render only the half-disc beyond the line's end (Flux's split-half trick,
// adapted for additive blending) so the overlap with the line isn't doubled.
const CAP_VERT = /* glsl */ `
// ShaderMaterial(GLSL3) injects position (dummy); corner comes from aCorner.
in vec2 aCorner;    // quad corner in [-1,1]^2
in vec2 aGrid;      // grid cell (gx, gy)
uniform sampler2D uState;
uniform sampler2D uVelocity;
uniform vec2  uGridSize;
uniform float uAspect;
uniform float uZoom;
uniform float uLineWidth;
uniform float uVelGain;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
uniform float uTime;
out vec2  vVertex;
out vec2  vDir;
out vec3  vColor;
out float vAlpha;

vec3 palCyc(float x){
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  vec2 stateUv = (aGrid + 0.5) / uGridSize;
  vec2 basepoint = stateUv;
  vec2 endpoint = texture(uState, stateUv).xy;
  vec2 fluidVel = texture(uVelocity, basepoint).xy * uVelGain;
  float wb = clamp(2.5 * length(fluidVel), 0.0, 1.0);
  float lineWidth = wb * wb * (3.0 - 2.0 * wb);

  // Quad centred on the line's head, half-size = half the line width (Flux:
  // 0.5 * uLineWidth * iLineWidth * vertex), same pre-aspect-divide convention.
  vec2 head = vec2(uAspect, 1.0) * uZoom * (basepoint * 2.0 - 1.0) + endpoint;
  vec2 pt = head + 0.5 * uLineWidth * lineWidth * aCorner;
  pt.x /= uAspect;
  gl_Position = vec4(pt, 0.0, 1.0);

  vVertex = aCorner;
  vDir = endpoint / (length(endpoint) + 1e-5);   // line direction, for the half test
  float angle = atan(fluidVel.y, fluidVel.x) / 6.28318 + 0.5;
  vColor = palCyc(angle + 0.35 * (basepoint.x + basepoint.y) + 0.01 * uTime);
  vAlpha = wb;
}
`;
const CAP_FRAG = /* glsl */ `
precision highp float;
in vec2  vVertex;
in vec2  vDir;
in vec3  vColor;
in float vAlpha;
out vec4 fragColor;
uniform float uGlow;
void main() {
  float d = length(vVertex);
  float edge = 1.0 - smoothstep(1.0 - fwidth(d), 1.0, d);      // AA disc (Flux endpoint.frag)
  // Keep only the half beyond the line's end; the line itself covers the rest.
  float along = dot(vVertex, vDir);
  float side = smoothstep(-fwidth(along), fwidth(along), along);
  float a = vAlpha * edge * side;
  if (a <= 0.0009) discard;
  fragColor = vec4(vColor * a * uGlow, 1.0);                   // additive, matches line head
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
uniform float uVelScale;
void main(){
  vec2 v = texture(uVelocity, vUv).xy * uVelScale;
  fragColor = vec4(0.5 + 30.0 * v, 0.5, 1.0);
}
`;

// Native-control mapping (parity model). Size → fluid energy + swirl; Intensity →
// glow; Density → visible line fraction; Speed → simulation rate; Style → palette.
const DEFAULT_THEME = "aurora";
const NATIVE = { speed: 0.3, intensity: 1.0, density: 0.5, size: 0.85 };

// Real-time → sim-time scale. Flux at 60fps (scale 1.0) evolves ~4.8x faster than
// the macOS Drift reference (measured: 44ms vs 210ms half-decorrelation), so we run
// the simulation slower in real time. The per-step physics are unchanged, so the
// smaller dt ALSO makes the spring settle slower in real time — reproducing the
// reference's inertial, slow-start motion. Field strength lost to the smaller dt is
// restored by scaling uLineLength (1/TIME_SCALE), which touches only stroke length,
// never the fluid dynamics. Tuned against the reference decorrelation curve.
const TIME_SCALE = 0.115;
const BASE_LINE_LENGTH = 0.6;   // Flux line_length uniform (velocity is rescaled by VEL_GAIN, not this)
// The slowed sim has a weaker velocity field; VEL_GAIN rescales the sampled velocity
// back to Flux's ~0.1 magnitude for rendering + the spring, so length AND width are
// correct while evolution stays slow. Purely a read-side gain — no effect on motion rate.
const VEL_GAIN = 10.0;
// With velocity_dissipation = 0 (Flux's default) the field has no energy sink and
// grows unbounded over a long run (fine for a 38s clip, wrong for a screensaver that
// runs for hours). A modest dissipation gives a STABLE equilibrium (|v| ≈ noise/diss,
// independent of timestep) so the look holds indefinitely.
const DISSIPATION = 2.0;

function makeStateRT(): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(GX, GY, {
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

  // Line-state ping-pong.
  private stateA!: THREE.WebGLRenderTarget;
  private stateB!: THREE.WebGLRenderTarget;
  private springMat!: THREE.RawShaderMaterial;
  private readonly springScene = new THREE.Scene();
  private springQuad!: THREE.Mesh;

  private lineMat!: THREE.ShaderMaterial;
  private lineMesh!: THREE.Mesh;
  private capMat!: THREE.ShaderMaterial;
  private capMesh!: THREE.Mesh;

  private debugMat: THREE.RawShaderMaterial | null = null;
  private readonly debugScene = new THREE.Scene();
  private readonly debug =
    typeof location !== "undefined" && new URLSearchParams(location.search).get("fluxdebug") === "1";

  // Native-control state.
  private speed = NATIVE.speed;
  private size = NATIVE.size;
  private density = NATIVE.density;
  private aspect = 1;
  private simTime = 0;     // accumulated fixed-step sim time (deterministic, drives noise scroll)

  init(ctx: SceneContext): void {
    this.renderer = ctx.renderer;
    this.fluid = new FluxFluid(this.renderer, 128);

    // Warm up the fluid so the first visible frame already has structure. Use the
    // stable-run dissipation so warm-up settles at the same equilibrium the running
    // sim holds (no first-second brightness transient).
    this.fluidSettings.timestep = 1 / 60;
    this.fluidSettings.velocityDissipation = DISSIPATION;
    for (let i = 0; i < 150; i++) { this.simTime += 1 / 60; this.fluid.step(this.renderer, this.simTime, this.fluidSettings); }

    // Line-state textures + spring pass.
    this.stateA = makeStateRT();
    this.stateB = makeStateRT();
    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.springMat = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: SPRING_VERT,
      fragmentShader: SPRING_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uVelocity: { value: null },
        uState: { value: null },
        uGridSize: { value: new THREE.Vector2(GX, GY) },
        uLineLength: { value: BASE_LINE_LENGTH },
        uLineVariance: { value: 0.45 },
        uVelGain: { value: VEL_GAIN },
        uDeltaTime: { value: 1 / 60 },
      },
    });
    this.springQuad = new THREE.Mesh(tri, this.springMat);
    this.springQuad.frustumCulled = false;
    this.springScene.add(this.springQuad);

    // Non-instanced indexed line geometry (the proven-rendering structure): 4 real
    // vertices per line + 6 indices, each vertex tagged with its grid cell + corner.
    // Density is controlled by the draw range.
    const cornerPat = [-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1];
    const N = NUM_LINES * 4;
    const position = new Float32Array(N * 3); // dummy
    const aCorner = new Float32Array(N * 2);
    const aGrid = new Float32Array(N * 2);
    const indices = new Uint32Array(NUM_LINES * 6);
    // Cells placed in a coprime-stride-permuted order (7001 ⟂ 9216) so that drawing
    // any prefix of the lines (Density < 1) still covers the whole screen evenly —
    // no rigid lattice of holes. Default density draws most of them.
    for (let i = 0; i < NUM_LINES; i++) {
      const cell = (i * 7001) % NUM_LINES;
      const gx = cell % GX, gy = Math.floor(cell / GX);
      const base = i * 4;
      for (let k = 0; k < 4; k++) {
        const vi = base + k;
        aCorner[vi * 2] = cornerPat[k * 2];
        aCorner[vi * 2 + 1] = cornerPat[k * 2 + 1];
        aGrid[vi * 2] = gx;
        aGrid[vi * 2 + 1] = gy;
      }
      const ii = i * 6;
      indices[ii] = base; indices[ii + 1] = base + 1; indices[ii + 2] = base + 2;
      indices[ii + 3] = base + 2; indices[ii + 4] = base + 1; indices[ii + 5] = base + 3;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("aCorner", new THREE.BufferAttribute(aCorner, 2));
    geo.setAttribute("aGrid", new THREE.BufferAttribute(aGrid, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    // Density maps to how many lines are drawn (hole-free thanks to the stratified
    // order above). Default 0.5 already reads as a full carpet at this grid density.
    geo.setDrawRange(0, Math.floor(NUM_LINES * (0.65 + 0.35 * NATIVE.density)) * 6);

    const p = paletteById(DEFAULT_THEME);
    this.lineMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: LINE_VERT,
      fragmentShader: LINE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // line quads flip winding with flow direction — never cull
      blending: THREE.AdditiveBlending,
      uniforms: {
        uState: { value: this.stateA.texture },
        uVelocity: { value: this.fluid.velocityTexture },
        uGridSize: { value: new THREE.Vector2(GX, GY) },
        uAspect: { value: 1 },
        uZoom: { value: 1.6 }, // Flux view_scale — zooms into the fluid
        uLineWidth: { value: 0.011 }, // Flux: view_scale*line_width*scale_factor ≈ 0.011 (velocity-scaled in shader)
        uBeginOffset: { value: 0.4 }, // Flux line_begin_offset
        uVelGain: { value: VEL_GAIN },
        uGlow: { value: 1.0 + NATIVE.intensity },
        uColorA: { value: hexToColor(p.a) },
        uColorB: { value: hexToColor(p.b) },
        uColorC: { value: hexToColor(p.c) },
        uTime: { value: 0 },
      },
    });
    this.lineMesh = new THREE.Mesh(geo, this.lineMat);
    this.lineMesh.frustumCulled = false;
    this.scene.add(this.lineMesh);

    // Rounded endpoint caps (Flux endpoint pass): same per-line layout, but the
    // quad corner spans [-1,1]² and is centred on the head. Shares the dummy
    // position, aGrid, and index buffers; only the corner attribute differs.
    const capCornerPat = [-1, -1, 1, -1, -1, 1, 1, 1];
    const aCapCorner = new Float32Array(N * 2);
    for (let i = 0; i < NUM_LINES; i++) {
      const base = i * 4;
      for (let k = 0; k < 4; k++) {
        aCapCorner[(base + k) * 2] = capCornerPat[k * 2];
        aCapCorner[(base + k) * 2 + 1] = capCornerPat[k * 2 + 1];
      }
    }
    const capGeo = new THREE.BufferGeometry();
    capGeo.setAttribute("position", geo.getAttribute("position"));
    capGeo.setAttribute("aCorner", new THREE.BufferAttribute(aCapCorner, 2));
    capGeo.setAttribute("aGrid", geo.getAttribute("aGrid"));
    capGeo.setIndex(geo.getIndex());
    capGeo.setDrawRange(0, geo.drawRange.count);
    this.capMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: CAP_VERT,
      fragmentShader: CAP_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uState: { value: this.stateA.texture },
        uVelocity: { value: this.fluid.velocityTexture },
        uGridSize: { value: new THREE.Vector2(GX, GY) },
        uAspect: { value: 1 },
        uZoom: { value: 1.6 },
        uLineWidth: { value: 0.011 },
        uVelGain: { value: VEL_GAIN },
        uGlow: { value: 1.0 + NATIVE.intensity },
        uColorA: { value: hexToColor(p.a) },
        uColorB: { value: hexToColor(p.b) },
        uColorC: { value: hexToColor(p.c) },
        uTime: { value: 0 },
      },
    });
    this.capMesh = new THREE.Mesh(capGeo, this.capMat);
    this.capMesh.frustumCulled = false;
    this.scene.add(this.capMesh); // added after lines → draws on top

    this.applyControls();

    if (this.debug) {
      this.debugMat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3, vertexShader: DEBUG_VERT, fragmentShader: DEBUG_FRAG,
        depthTest: false, depthWrite: false,
        uniforms: { uVelocity: { value: this.fluid.velocityTexture }, uVelScale: { value: 1.0 } },
      });
      const dq = new THREE.Mesh(tri.clone(), this.debugMat);
      dq.frustumCulled = false;
      this.debugScene.add(dq);
    }
  }

  /** Map the native controls onto fluid + line uniforms. */
  private applyControls(): void {
    // At DEFAULT knob positions everything equals Flux's defaults (so the scene
    // matches the reference out of the box); the controls only nudge from there.
    // Size → fluid force strength (bigger, more energetic swirls) and stroke length.
    // Density → grid draw fraction (handled in setParameter). Speed → sim rate.
    this.fluidSettings.noiseMultiplier = 0.75 + 0.30 * (this.size - NATIVE.size) / 0.85; // 1.0 at default size
    this.fluidSettings.velocityDissipation = DISSIPATION; // stable field energy for long runs
    const s = this.springMat.uniforms;
    // Size nudges stroke length around the Flux baseline.
    s.uLineLength.value = BASE_LINE_LENGTH * (1.0 + 0.5 * (this.size - NATIVE.size));
  }

  update(_time: number, delta: number): void {
    // ONE smooth sim step per rendered frame (no stutter), advanced by real time so
    // motion runs at a fixed real-world rate on any hardware. dt is scaled by
    // TIME_SCALE to match the reference's slow evolution; the small dt also makes the
    // spring settle slowly = inertial motion. Speed multiplies the rate.
    const speedScale = this.speed / NATIVE.speed;
    const dt = Math.min(Math.max(delta, 0), 0.05) * TIME_SCALE * speedScale;
    if (dt <= 0) return;
    this.simTime += dt;
    if (this.simTime > 1000) this.simTime -= 1000; // wrap (Flux MAX_ELAPSED_TIME) — float safety over long runs

    this.fluidSettings.timestep = dt;
    this.fluid.step(this.renderer, this.simTime, this.fluidSettings);

    const su = this.springMat.uniforms;
    su.uDeltaTime.value = dt;
    su.uVelocity.value = this.fluid.velocityTexture;
    su.uState.value = this.stateA.texture;
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.stateB);
    this.renderer.render(this.springScene, this.camera);
    const t = this.stateA; this.stateA = this.stateB; this.stateB = t;
    this.renderer.setRenderTarget(prev);

    // Point the line material at the fresh state + velocity.
    this.lineMat.uniforms.uState.value = this.stateA.texture;
    this.lineMat.uniforms.uVelocity.value = this.fluid.velocityTexture;
    this.lineMat.uniforms.uTime.value = this.simTime;
    this.capMat.uniforms.uState.value = this.stateA.texture;
    this.capMat.uniforms.uVelocity.value = this.fluid.velocityTexture;
    this.capMat.uniforms.uTime.value = this.simTime;
    if (this.debugMat) this.debugMat.uniforms.uVelocity.value = this.fluid.velocityTexture;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x05040c, 1);
    renderer.clear();
    if (this.debug && this.debugMat) {
      renderer.render(this.debugScene, this.camera);
      return;
    }
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    this.lineMat.uniforms.uAspect.value = this.aspect;
    this.capMat.uniforms.uAspect.value = this.aspect;
  }

  setParameter(id: string, value: ParameterValue): void {
    switch (id) {
      case "speed":
        this.speed = Number(value);
        break;
      case "intensity":
        this.lineMat.uniforms.uGlow.value = 1.0 + Number(value);
        this.capMat.uniforms.uGlow.value = 1.0 + Number(value);
        break;
      case "density": {
        this.density = Number(value);
        // 0..1 → 0.5..1.0 fraction of lines drawn (stratified order = hole-free).
        const range = Math.floor(NUM_LINES * (0.65 + 0.35 * this.density)) * 6;
        this.lineMesh.geometry.setDrawRange(0, range);
        this.capMesh.geometry.setDrawRange(0, range);
        break;
      }
      case "size":
        this.size = Number(value);
        this.applyControls();
        break;
      case "theme": {
        const p = paletteById(String(value));
        for (const m of [this.lineMat, this.capMat]) {
          (m.uniforms.uColorA.value as THREE.Color).set(p.a);
          (m.uniforms.uColorB.value as THREE.Color).set(p.b);
          (m.uniforms.uColorC.value as THREE.Color).set(p.c);
        }
        break;
      }
    }
  }

  dispose(): void {
    this.fluid?.dispose();
    this.stateA?.dispose();
    this.stateB?.dispose();
    this.springMat?.dispose();
    this.springQuad?.geometry.dispose();
    this.lineMat?.dispose();
    this.lineMesh?.geometry.dispose();
    this.capMat?.dispose();
    this.capMesh?.geometry.dispose();
    this.debugMat?.dispose();
    if (this.lineMesh) this.scene.remove(this.lineMesh);
    if (this.capMesh) this.scene.remove(this.capMesh);
  }
}
