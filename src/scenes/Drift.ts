import * as THREE from "three";
import type { Parameter, ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";
import { SIMPLEX_2D } from "../engine/shaders/noise.glsl";

/**
 * Flux Drift — an homage to the macOS "Drift" screensaver and its open-source
 * tribute Flux (github.com/sandydoo/flux). Thousands of long luminous ribbons of
 * light stream along a slowly-evolving flow field, curling around vortices —
 * bright where the current runs fast, fading in calm — over a near-black field.
 *
 * ARCHITECTURE (the reason this is both faithful AND cheap): it is NOT a per-pixel
 * effect. Like the reference, it draws real LINE geometry — one thin tapered
 * ribbon per streamline — and integrates each ribbon's path through the flow field
 * entirely in the VERTEX shader (stateless, exactly like the Particle Drift
 * scene). Each ribbon vertex marches a few Euler steps along the flow from the
 * ribbon's fixed basepoint, so a long flowing line costs a handful of vertices,
 * not a quadratic per-pixel neighbourhood search. The GPU rasterizer fills the
 * ribbons additively for free. The flow itself is the curl of a 2D-simplex stream
 * function that drifts with time — that time evolution is the "drift" motion.
 */

const MAX_LINES = 9000; // ribbons; density scales the visible draw range
const SEGMENTS = 22; // points along each ribbon (→ SEGMENTS+1 samples)
const STEPS = 22; // max Euler integration steps (== SEGMENTS so the tip is fully integrated)

const VERT = /* glsl */ `
precision highp float;
attribute vec2  aBase;   // ribbon basepoint (tail) in aspect-corrected flow space
attribute float aParam;  // 0 at tail .. 1 at head, along the ribbon
attribute float aSide;   // -1 / +1 — which edge of the ribbon this vertex is
attribute float aRnd;    // per-ribbon random
uniform float uTime;
uniform float uSpeed;
uniform float uFlow;     // swirl scale (larger = smaller, tighter vortices)
uniform float uLen;      // ribbon length in flow-space units
uniform float uWidth;    // ribbon half-width in NDC (screen space)
uniform float uGlow;     // brightness multiplier
uniform float uAspect;
uniform vec3  uColorA;
uniform vec3  uColorB;
uniform vec3  uColorC;
varying float vAlpha;
varying vec3  vColor;

${SIMPLEX_2D}

// 2-octave simplex stream function whose sample point drifts with time. Its curl
// is a smooth, slowly-evolving, divergence-free flow — the field the ribbons comb.
float streamPsi(vec2 p, float t) {
  vec2 dr = vec2(t * 0.06, -t * 0.045);
  return snoise(p * 0.9 + dr) + 0.35 * snoise(p * 2.1 - dr * 1.3 + 11.0);
}
// Flow velocity = curl(psi), UN-normalized so |v| = local flow speed. A gentle
// constant bias keeps the flow moving where the gradient vanishes (no starbursts).
vec2 velocityAt(vec2 p, float t) {
  const float e = 0.03;
  float c  = streamPsi(p, t);
  float dx = streamPsi(p + vec2(e, 0.0), t) - c;
  float dy = streamPsi(p + vec2(0.0, e), t) - c;
  return vec2(dy, -dx) / e + vec2(0.30, 0.11);
}

// A->B->C->A palette cycle for the big colour zones.
vec3 ncCyc(float x) {
  float f = fract(x);
  if (f < 0.3333) return mix(uColorA, uColorB, f / 0.3333);
  if (f < 0.6666) return mix(uColorB, uColorC, (f - 0.3333) / 0.3333);
  return mix(uColorC, uColorA, (f - 0.6666) / 0.3334);
}

void main() {
  float t = uTime * uSpeed;
  float ds = uLen / float(${STEPS});
  float target = aParam * float(${STEPS}); // fractional arc position, in steps

  // March the streamline from the basepoint up to this vertex's arc position.
  // We advance for exactly "target" steps using step() as the gate — no dynamic
  // loop break (unreliable in GLSL ES 1.0; it made every vertex integrate the full
  // path, collapsing each ribbon to a point). Both ribbon edges (aSide = +/-1) run
  // the same integration; only the perpendicular offset differs, so the strip
  // stays connected.
  vec2 p = aBase;
  vec2 v = velocityAt(p * uFlow, t);
  float speedSum = length(v);
  for (int k = 0; k < ${STEPS}; k++) {
    float gate = step(float(k) + 0.5, target); // 1 while k < target, else 0
    vec2 dir = v / max(length(v), 1e-4);
    p += dir * ds * gate;
    v = velocityAt(p * uFlow, t);
    speedSum += length(v) * gate;
  }
  float speed = speedSum / (target + 1.0);

  // Map the streamline point to clip space (x is aspect-stretched), and build a
  // screen-space perpendicular so the ribbon width is uniform in pixels.
  vec2 clip = vec2(p.x * 2.0 / uAspect, p.y * 2.0);
  vec2 tang = v / max(length(v), 1e-4);
  vec2 tangClip = normalize(vec2(tang.x * 2.0 / uAspect, tang.y * 2.0));
  vec2 perpClip = vec2(-tangClip.y, tangClip.x);

  // Ribbon width: taper toward both ends (brush-stroke), and thin out in calm
  // water so vortices open into black negative space.
  float lenBoost = smoothstep(0.03, 0.6, speed);
  float endTaper = sin(aParam * 3.14159);
  float w = uWidth * (0.3 + 0.7 * endTaper) * (0.4 + 0.6 * lenBoost);
  gl_Position = vec4(clip + perpClip * (aSide * w), 0.0, 1.0);

  // Brightness: fades tail->head (comet), scales with flow speed, and a per-ribbon
  // travelling wave streams the light along the ribbon so the field shimmers.
  float head = smoothstep(0.0, 0.5, aParam);
  float streamWave = 0.6 + 0.4 * sin(aParam * 6.0 - t * 2.0 + aRnd * 6.2831);
  vAlpha = head * lenBoost * streamWave * (0.45 + 0.55 * aRnd) * uGlow;

  // Colour: big smooth palette zones by tail position + a diagonal sweep so all
  // three stops appear across the frame; nudged by flow direction for variety.
  float creg = 0.6 * snoise(aBase * uFlow * 0.25) + 0.5 * (aBase.x + aBase.y) + 0.05 * t;
  vColor = ncCyc(creg + 0.06 * tang.x);
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vAlpha;
varying vec3  vColor;
void main() {
  if (vAlpha <= 0.001) discard;
  gl_FragColor = vec4(vColor * vAlpha, 1.0); // additive; alpha folded into colour
}
`;

const DEFAULT_THEME = "nebula";
const DEFAULT_SPEED = 0.5;
const DEFAULT_FLOW = 2.0;
const DEFAULT_DENSITY = 0.6; // fraction of MAX_LINES drawn
const DEFAULT_LEN = 0.4; // ribbon length (flow-space units)
const DEFAULT_GLOW = 1.0;
// Drift's signature is multi-hue; default to a vibrant magenta/emerald/blue triad.
const DRIFT_A = "#e01e8f";
const DRIFT_B = "#22c55e";
const DRIFT_C = "#3b7bf5";

export class Drift implements Scene {
  readonly id = "drift";
  readonly name = "Flux Drift";
  readonly description = "Ribbons of light streaming along a flow field — the macOS Drift look.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.05, max: 1.5, step: 0.01, default: DEFAULT_SPEED },
    { kind: "range", id: "scale", label: "Swirl Scale", min: 1.0, max: 4.0, step: 0.1, default: DEFAULT_FLOW },
    { kind: "range", id: "density", label: "Density", min: 0.2, max: 1.0, step: 0.01, default: DEFAULT_DENSITY },
    { kind: "range", id: "length", label: "Ribbon Length", min: 0.12, max: 0.55, step: 0.01, default: DEFAULT_LEN },
    { kind: "range", id: "glow", label: "Glow", min: 0.4, max: 2.0, step: 0.05, default: DEFAULT_GLOW },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: DEFAULT_THEME },
    { kind: "color", id: "colorA", label: "Color A", default: DRIFT_A },
    { kind: "color", id: "colorB", label: "Color B", default: DRIFT_B },
    { kind: "color", id: "colorC", label: "Color C", default: DRIFT_C },
  ];

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera(); // pass-through: vertex shader emits clip space
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;
  private glow = DEFAULT_GLOW;

  init(_ctx: SceneContext): void {
    const vertsPerLine = (SEGMENTS + 1) * 2;
    const totalVerts = MAX_LINES * vertsPerLine;
    const aBase = new Float32Array(totalVerts * 2);
    const aParam = new Float32Array(totalVerts);
    const aSide = new Float32Array(totalVerts);
    const aRnd = new Float32Array(totalVerts);
    const indices = new Uint32Array(MAX_LINES * SEGMENTS * 6);

    // Deterministic PRNG (no Math.random — reproducible, and avoids the banned RNG
    // in restricted contexts, matching the other scenes).
    let s = 0x2545f491 >>> 0;
    const rand = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      return (s % 100000) / 100000;
    };

    let vi = 0;
    let ii = 0;
    for (let line = 0; line < MAX_LINES; line++) {
      // Basepoints spread over the aspect-corrected flow space with margin so
      // ribbons that flow off one edge are replaced by others flowing in.
      const bx = (rand() - 0.5) * 3.4; // covers wide/ultrawide after aspect divide
      const by = (rand() - 0.5) * 1.25;
      const r = rand();
      const baseVert = vi;
      for (let j = 0; j <= SEGMENTS; j++) {
        const param = j / SEGMENTS;
        for (let side = 0; side < 2; side++) {
          aBase[vi * 2 + 0] = bx;
          aBase[vi * 2 + 1] = by;
          aParam[vi] = param;
          aSide[vi] = side === 0 ? -1 : 1;
          aRnd[vi] = r;
          vi++;
        }
      }
      // Triangle strip for this ribbon.
      for (let j = 0; j < SEGMENTS; j++) {
        const a = baseVert + j * 2;
        indices[ii++] = a;
        indices[ii++] = a + 1;
        indices[ii++] = a + 2;
        indices[ii++] = a + 1;
        indices[ii++] = a + 3;
        indices[ii++] = a + 2;
      }
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("aBase", new THREE.BufferAttribute(aBase, 2));
    this.geometry.setAttribute("aParam", new THREE.BufferAttribute(aParam, 1));
    this.geometry.setAttribute("aSide", new THREE.BufferAttribute(aSide, 1));
    this.geometry.setAttribute("aRnd", new THREE.BufferAttribute(aRnd, 1));
    // Dummy position attribute keeps Three.js happy; the vertex shader ignores it.
    this.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(totalVerts * 3), 3));
    this.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    this.geometry.setDrawRange(0, Math.floor(MAX_LINES * DEFAULT_DENSITY) * SEGMENTS * 6);

    const p = paletteById(DEFAULT_THEME);
    void p; // palette theme is applied via setParameter; defaults use the triad below

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide, // ribbons are flat quads — never cull by facing
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uFlow: { value: DEFAULT_FLOW },
        uLen: { value: DEFAULT_LEN },
        uWidth: { value: 0.0055 },
        uGlow: { value: DEFAULT_GLOW },
        uAspect: { value: 1 },
        uColorA: { value: hexToColor(DRIFT_A) },
        uColorB: { value: hexToColor(DRIFT_B) },
        uColorC: { value: hexToColor(DRIFT_C) },
      },
    });

    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  update(time: number, _delta: number): void {
    if (this.material) this.material.uniforms.uTime.value = time;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x04030a, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    if (this.material) this.material.uniforms.uAspect.value = width / Math.max(height, 1);
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material?.uniforms;
    if (!u) return;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "scale":
        u.uFlow.value = Number(value);
        break;
      case "density":
        this.geometry?.setDrawRange(0, Math.floor(MAX_LINES * Number(value)) * SEGMENTS * 6);
        break;
      case "length":
        u.uLen.value = Number(value);
        break;
      case "glow":
        this.glow = Number(value);
        u.uGlow.value = this.glow;
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorA.value as THREE.Color).set(p.a);
        (u.uColorB.value as THREE.Color).set(p.b);
        (u.uColorC.value as THREE.Color).set(p.c);
        break;
      }
      case "colorA":
        (u.uColorA.value as THREE.Color).set(String(value));
        break;
      case "colorB":
        (u.uColorB.value as THREE.Color).set(String(value));
        break;
      case "colorC":
        (u.uColorC.value as THREE.Color).set(String(value));
        break;
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = null;
  }
}
