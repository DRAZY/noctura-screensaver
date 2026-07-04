import * as THREE from "three";
import type { ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { NATIVE_PARAMETERS } from "../engine/sceneParams";

/**
 * Flux Drift — a faithful, cheap reproduction of the macOS "Drift" screensaver and
 * its open-source tribute Flux (github.com/sandydoo/flux), built with Flux's ACTUAL
 * method rather than a per-pixel approximation:
 *
 *   • One short LINE per grid node — a single instanced quad, not an integrated
 *     ribbon. ~8000 lines = ~16k triangles total; the fragment work is trivial.
 *   • Each line's endpoint is a PERSISTENT damped-spring that chases the local flow
 *     (Flux's exact equation: v += ((line_length·flow − endpoint) − v·momentum)·dt).
 *     That inertia/lag/overshoot is what gives the smooth, living sway — the thing
 *     a stateless per-frame re-derivation can never capture.
 *   • The flow velocity is sampled ONCE per line per frame on the CPU (a cheap 2D
 *     simplex curl that drifts with time). Flux samples a 128² fluid texture once
 *     per line; we substitute analytic curl-noise. Either way it's one sample per
 *     line — NOT the tens of per-vertex noise evals the old shader did (which cost
 *     ~50M noise/frame and was the real performance disaster).
 *   • Lines are additive, width/opacity scale with flow speed (calm water → black),
 *     and fade tail→head like a comet (Flux's line_begin_offset).
 *
 * CPU cost per frame: ~8000 × (one 2D-simplex curl + a few flops) — negligible.
 * GPU cost: ~8000 instanced quads — negligible. Runs smoothly on weak hardware.
 */

const MAX_LINES = 9000;

// ---- Vertex/fragment shaders (mirror Flux's line.wgsl) ---------------------
const VERT = /* glsl */ `
precision highp float;
// The quad corner comes from a dedicated aCorner attribute (NOT the injected
// position, which stays a dummy) — this mirrors the proven-rendering geometry
// layout. aCorner.x in [-0.5,0.5] (width), aCorner.y in [0,1] (base to tip).
attribute float aParam;
attribute float aSide;
attribute vec2  aBase;     // line basepoint in [0,1]^2 (instanced)
attribute vec2  aEnd;      // line endpoint OFFSET from basepoint, spring-driven (instanced)
attribute float aWidth;    // line width scale from flow speed (instanced)
attribute float aCreg;     // per-line colour-zone coordinate (instanced)
uniform float uAspect;
uniform float uLineWidth;  // base half-width in clip space
uniform float uBeginOffset;// tail fade start (Flux line_begin_offset)
uniform float uTime;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
varying vec2  vCorner;
varying vec3  vColor;
varying float vBeginOffset;
varying float vBright;

vec3 ncCyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  vec2 basePos = aBase * 2.0 - 1.0;                    // [-1,1]^2

  vec2 end = aEnd;                                     // spring-driven offset
  vec2 xb = normalize(vec2(-end.y, end.x) + 1e-6);     // perpendicular to the line
  // Slide along the line (corner.y) and out to the edge (corner.x), exactly like Flux.
  vec2 point = vec2(uAspect, 1.0) * basePos
             + end * aParam
             + uLineWidth * aWidth * xb * (aSide * 0.5);
  point.x /= uAspect;
  gl_Position = vec4(point, 0.0, 1.0);

  // Short lines would over-fade; scale the fade start down for them (Flux trick).
  float shortBoost = 1.0 + (uLineWidth * aWidth) / (length(end) + 1e-4);
  vBeginOffset = uBeginOffset / shortBoost;
  vCorner = vec2(aSide * 0.5, aParam);
  // Pull the palette toward its own luma (mix 0.72) → dusty, desaturated tones,
  // identical to the native .saver's sceneDrift so the Style control matches across
  // renderers. Additive overlap still lifts crossings toward cream.
  vec3 pc = ncCyc(aCreg + 0.02 * uTime);
  float pl = dot(pc, vec3(0.299, 0.587, 0.114));
  vColor = mix(vec3(pl), pc, 0.72);
  // aWidth already encodes flow speed (smoothstep). Carry it as brightness so calm
  // water goes fully black (negative space) and only fast flow lights up — the
  // sparse, breathing look of real Drift/Flux instead of a solid neon field.
  vBright = aWidth;
}
`;

const FRAG = /* glsl */ `
precision highp float;
uniform float uGlow;   // brightness multiplier = 1.0 + Intensity (native parity)
varying vec2  vCorner;
varying vec3  vColor;
varying float vBeginOffset;
varying float vBright;
void main() {
  float fade = smoothstep(vBeginOffset, 1.0, vCorner.y);   // tail dark → head bright
  float ew = fwidth(vCorner.x) + 1e-4;
  float edge = 1.0 - smoothstep(0.5 - ew, 0.5, abs(vCorner.x)); // AA across width
  // Fold flow-speed brightness in (squared → steep): calm flow ≈ black, fast flow
  // bright. This is what opens up the black negative space between the streams.
  float a = fade * edge * vBright * vBright;
  if (a <= 0.001) discard;
  gl_FragColor = vec4(vColor * a * uGlow, 1.0);            // additive; Intensity → uGlow
}
`;

// ---- Cheap 2D simplex noise on the CPU (Ashima port) for the flow field -----
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const perm = new Uint8Array(512);
const gx = new Float32Array(512);
const gy = new Float32Array(512);
(() => {
  // Deterministic permutation (no Math.random — reproducible, matches other scenes).
  let s = 0x2545f491 >>> 0;
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const j = s % (i + 1);
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  for (let i = 0; i < 512; i++) {
    const v = p[i & 255];
    const ang = (v / 256) * Math.PI * 2;
    perm[i] = v;
    gx[i] = Math.cos(ang);
    gy[i] = Math.sin(ang);
  }
})();
/** Divergence-free flow velocity (curl of a time-drifting simplex) at flow-space
 * point (px, py). Pure — no scene state. Writes the velocity into `out`. */
function velAt(px: number, py: number, t: number, out: { x: number; y: number }): void {
  const dxo = t * 0.06, dyo = -t * 0.045;
  const e = 0.02;
  const c = snoise2(px + dxo, py + dyo);
  const nx = snoise2(px + e + dxo, py + dyo) - c;
  const ny = snoise2(px + dxo, py + e + dyo) - c;
  out.x = ny / e + 0.12; // curl + a gentle laminar drift; calm regions stay near-zero → black
  out.y = -nx / e + 0.05;
}

function snoise2(xin: number, yin: number): number {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  let i1 = 0, j1 = 1;
  if (x0 > y0) { i1 = 1; j1 = 0; }
  const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
  const ii = i & 255, jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) { t0 *= t0; const g = perm[ii + perm[jj]]; n += t0 * t0 * (gx[g] * x0 + gy[g] * y0); }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) { t1 *= t1; const g = perm[ii + i1 + perm[jj + j1]]; n += t1 * t1 * (gx[g] * x1 + gy[g] * y1); }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) { t2 *= t2; const g = perm[ii + 1 + perm[jj + 1]]; n += t2 * t2 * (gx[g] * x2 + gy[g] * y2); }
  return 70 * n;
}

// Native-parity option model (mirrors the .saver/.scr global controls exactly):
// Speed / Intensity / Density / Size / Style, same ranges + defaults. See the
// macOS AuroraPreferences ranges and Windows settings.rs.
const DEFAULT_THEME = "aurora";     // native default palette is index 0 = Aurora
const DEFAULT_SPEED = 0.3;          // native speed default (range 0.03..1.2)
const DEFAULT_INTENSITY = 1.0;      // native intensity default (range 0.0..1.5) → glow
const DEFAULT_DENSITY = 0.5;        // native density default (range 0.0..1.0)
const DEFAULT_SIZE = 0.85;          // native size default (range 0.4..2.2) → swirl
const DEFAULT_LEN = 0.05; // fixed dash length (no native control for it)
const MAX_OFFSET = 0.12;  // hard cap on endpoint magnitude (clip space) — kills long spikes

/** Size → swirl-flow mapping, identical to the native sceneDrift shader
 * (`flow = 1.3 * clamp(size*1.05, 0.6, 1.7)`), so a given Size reads the same in
 * the web app and the .saver. */
function sizeToFlow(size: number): number {
  return 1.3 * Math.min(Math.max(size * 1.05, 0.6), 1.7);
}
/** Intensity → brightness glow, matching native `glow = 1.0 + intensity`. */
function intensityToGlow(intensity: number): number {
  return 1.0 + intensity;
}
// Colours are driven entirely by the selected Style/palette (no per-colour pickers,
// matching native). The shader desaturates them the same way the .saver does.
const defaultPalette = paletteById(DEFAULT_THEME);

export class Drift implements Scene {
  readonly id = "drift";
  readonly name = "Flux Drift";
  readonly description = "Lines of light drifting along a flow field — the macOS Drift look.";

  // Parity with the native .saver/.scr global controls: Speed / Intensity /
  // Density / Size / Style — the shared native model (see engine/sceneParams).
  readonly parameters = NATIVE_PARAMETERS;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera(); // pass-through: vertex shader emits clip space
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;

  // Per-line CPU state (Flux spring).
  private readonly baseX = new Float32Array(MAX_LINES);
  private readonly baseY = new Float32Array(MAX_LINES);
  private readonly offX = new Float32Array(MAX_LINES); // endpoint offset
  private readonly offY = new Float32Array(MAX_LINES);
  private readonly velX = new Float32Array(MAX_LINES);
  private readonly velY = new Float32Array(MAX_LINES);
  private readonly momentum = new Float32Array(MAX_LINES);
  private readonly deltaBoost = new Float32Array(MAX_LINES);
  private endAttr: THREE.BufferAttribute | null = null;   // aEnd, per vertex
  private widthAttr: THREE.BufferAttribute | null = null; // aWidth, per vertex
  private aspect = 1;
  private flow = sizeToFlow(DEFAULT_SIZE);
  private lineLen = DEFAULT_LEN;
  private timeScale = DEFAULT_SPEED;

  init(_ctx: SceneContext): void {
    // Non-instanced INDEXED geometry (matches the proven-rendering structure):
    // 4 vertices per line (a quad), 6 indices per line (2 tris). Per-line data is
    // duplicated across the 4 verts; only aEnd/aWidth re-upload each frame.
    const VPL = 4;
    const N = MAX_LINES * VPL;
    const cornerPat = [ -0.5, 0, 0.5, 0, -0.5, 1, 0.5, 1 ]; // (x,y) × 4
    const position = new Float32Array(N * 3); // dummy (all zeros) — geometry comes from aCorner
    const aParam = new Float32Array(N);
    const aSide = new Float32Array(N);
    const aBase = new Float32Array(N * 2);
    const aEnd = new Float32Array(N * 2);
    const aWidth = new Float32Array(N);
    const aCreg = new Float32Array(N);
    const indices = new Uint32Array(MAX_LINES * 6);

    let s = 0x9e3779b9 >>> 0;
    const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s % 100000) / 100000; };
    const seedV = { x: 0, y: 0 };

    // Jittered grid of basepoints (Flux's grid_spacing) — even coverage that combs
    // the flow uniformly, instead of random clumps that burst into spikes at vortices.
    // 120×75 = 9000 = MAX_LINES exactly (≈16:9). Cells are visited in a coprime-stride
    // order (5557 ⟂ 9000) so ANY density prefix still covers the whole screen evenly,
    // not just the first rows.
    const cols = 120, rows = 75;
    for (let i = 0; i < MAX_LINES; i++) {
      const cell = (i * 5557) % MAX_LINES; // bijective stratified permutation
      const gx = cell % cols, gy = Math.floor(cell / cols);
      const bx = (gx + 0.5 + (rand() - 0.5) * 0.7) / cols; // cell center + mild jitter
      const by = (gy + 0.5 + (rand() - 0.5) * 0.7) / rows;
      this.baseX[i] = bx; this.baseY[i] = by;
      const variance = 1 - 0.55 * rand();
      this.momentum[i] = 3 + 2 * variance;          // 3..5
      this.deltaBoost[i] = 4 + 18 * (1 - variance);  // ~4..22
      const creg = 0.6 * snoise2(bx * 2.2, by * 2.2) + 0.5 * (bx + by);
      // Seed the endpoint at its steady-state (spring target) so the first frame
      // already shows the lines rather than degenerate zero-length quads.
      velAt(bx * this.flow, by * this.flow, 0, seedV);
      this.offX[i] = DEFAULT_LEN * seedV.x;
      this.offY[i] = DEFAULT_LEN * seedV.y;
      const sp = Math.hypot(seedV.x, seedV.y);
      const wbs = Math.min(2.5 * sp, 1);
      const w0 = wbs * wbs * (3 - 2 * wbs);
      const base = i * VPL;
      for (let k = 0; k < VPL; k++) {
        const vi = base + k;
        aSide[vi] = cornerPat[k * 2] * 2.0;
        aParam[vi] = cornerPat[k * 2 + 1];
        aBase[vi * 2] = bx; aBase[vi * 2 + 1] = by;
        aEnd[vi * 2] = this.offX[i]; aEnd[vi * 2 + 1] = this.offY[i];
        aWidth[vi] = w0;
        aCreg[vi] = creg;
      }
      const ii = i * 6;
      indices[ii] = base; indices[ii + 1] = base + 1; indices[ii + 2] = base + 2;
      indices[ii + 3] = base + 2; indices[ii + 4] = base + 1; indices[ii + 5] = base + 3;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
    geo.setAttribute("aParam", new THREE.BufferAttribute(aParam, 1));
    geo.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
    geo.setAttribute("aBase", new THREE.BufferAttribute(aBase, 2));
    this.endAttr = new THREE.BufferAttribute(aEnd, 2);
    this.widthAttr = new THREE.BufferAttribute(aWidth, 1);
    this.endAttr.setUsage(THREE.DynamicDrawUsage);
    this.widthAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("aEnd", this.endAttr);
    geo.setAttribute("aWidth", this.widthAttr);
    geo.setAttribute("aCreg", new THREE.BufferAttribute(aCreg, 1));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.setDrawRange(0, Math.floor(MAX_LINES * DEFAULT_DENSITY) * 6);
    this.geometry = geo;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // lines are flat quads with flow-dependent winding — never cull
      blending: THREE.AdditiveBlending,
      uniforms: {
        uAspect: { value: 1 },
        uLineWidth: { value: 0.014 }, // fixed stroke width (no native line-width control)
        uBeginOffset: { value: 0.4 },
        uTime: { value: 0 },
        uGlow: { value: intensityToGlow(DEFAULT_INTENSITY) },
        uColorA: { value: hexToColor(defaultPalette.a) },
        uColorB: { value: hexToColor(defaultPalette.b) },
        uColorC: { value: hexToColor(defaultPalette.c) },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  update(time: number, delta: number): void {
    if (!this.material || !this.endAttr || !this.widthAttr) return;
    this.material.uniforms.uTime.value = time;
    const t = time * this.timeScale;
    const dt = Math.min(Math.max(delta, 0), 0.05); // clamp so a hitch can't fling springs

    const VPL = 4;
    const end = this.endAttr.array as Float32Array;
    const wid = this.widthAttr.array as Float32Array;
    const v = { x: 0, y: 0 };
    const lines = Math.floor((this.geometry?.drawRange.count ?? MAX_LINES * 6) / 6);

    for (let i = 0; i < lines; i++) {
      velAt(this.baseX[i] * this.flow, this.baseY[i] * this.flow, t, v);
      const speed = Math.hypot(v.x, v.y);
      const tx = this.lineLen * v.x; // spring target (Flux: line_length·flow)
      const ty = this.lineLen * v.y;
      // Flux's damped-spring endpoint: the offset chases the target with momentum and
      // lag — the smooth inertial sway a stateless re-derivation can't produce.
      const m = this.momentum[i], db = this.deltaBoost[i];
      this.velX[i] = (1 - dt * m) * this.velX[i] + (tx - this.offX[i]) * db * dt;
      this.velY[i] = (1 - dt * m) * this.velY[i] + (ty - this.offY[i]) * db * dt;
      this.offX[i] += dt * this.velX[i];
      this.offY[i] += dt * this.velY[i];
      // Cap endpoint length so a fast spring can't fling a line into a long spike.
      const olen = Math.hypot(this.offX[i], this.offY[i]);
      if (olen > MAX_OFFSET) { const k = MAX_OFFSET / olen; this.offX[i] *= k; this.offY[i] *= k; }
      // Steeper, higher-threshold speed gate: slow flow → 0 so those lines vanish
      // into black; only genuinely fast streams light up (Drift's breathing sparseness).
      const wb = Math.min(Math.max(1.7 * speed - 0.25, 0), 1);
      const w = wb * wb * (3 - 2 * wb); // smoothstep(0,1,wb): calm water → nothing
      const ox = this.offX[i], oy = this.offY[i];
      for (let k = 0; k < VPL; k++) {
        const vi = i * VPL + k;
        end[vi * 2] = ox; end[vi * 2 + 1] = oy;
        wid[vi] = w;
      }
    }
    this.endAttr.needsUpdate = true;
    this.widthAttr.needsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x04030a, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.aspect = width / Math.max(height, 1);
    if (this.material) this.material.uniforms.uAspect.value = this.aspect;
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material?.uniforms;
    if (!u) return;
    switch (id) {
      case "speed": // native Speed → time scale
        this.timeScale = Number(value);
        break;
      case "intensity": // native Intensity → brightness glow (glow = 1 + intensity)
        u.uGlow.value = intensityToGlow(Number(value));
        break;
      case "density": // native Density → visible line count
        if (this.geometry) this.geometry.setDrawRange(0, Math.floor(MAX_LINES * Number(value)) * 6);
        break;
      case "size": // native Size → swirl flow (same formula as the .saver shader)
        this.flow = sizeToFlow(Number(value));
        break;
      case "theme": { // native Style → palette (colours desaturated in-shader)
        const p = paletteById(String(value));
        (u.uColorA.value as THREE.Color).set(p.a);
        (u.uColorB.value as THREE.Color).set(p.b);
        (u.uColorC.value as THREE.Color).set(p.c);
        break;
      }
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = null;
  }
}
