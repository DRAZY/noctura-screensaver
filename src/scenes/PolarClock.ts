import * as THREE from "three";
import type { Parameter, ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById, PALETTE_OPTIONS } from "../engine/palette";

/**
 * Polar Clock: concentric animated arcs for seconds, minutes, hours, day, and
 * month, read from live local time each frame and rendered as smooth
 * anti-aliased rings. A calm, useful "utility" scene to balance the gallery's
 * abstract visuals.
 */

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform vec2  uResolution;
uniform float uThickness;
uniform float uTicks;       // 0/1 hour ticks on outer ring
uniform float uFrac[5];     // sec, min, hour, day, month  (0..1)
uniform vec3  uArc;
uniform vec3  uTrack;
uniform vec3  uBg;

const float TAU = 6.28318530718;

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2((vUv.x - 0.5) * aspect, vUv.y - 0.5);
  float r = length(p);
  float ang = atan(p.x, p.y);        // clockwise from top, -PI..PI
  float frac = fract(ang / TAU);     // 0..1
  // Pixel-size derivatives → resolution-independent, razor-crisp edges. The
  // angular term is clamped so the atan wrap-seam at 12 o'clock can't blow the
  // AA width up into a visible glitch.
  float aaR = fwidth(r);
  float aaA = min(fwidth(frac), 0.02);

  vec3 col = uBg;
  float ht = uThickness * 0.5;

  for (int i = 0; i < 5; i++) {
    float radius = 0.40 - float(i) * 0.072;
    float ring = smoothstep(ht + aaR, ht - aaR, abs(r - radius)); // crisp band
    vec3 tint = mix(uArc, uTrack, float(i) / 6.0);

    // Dim full-circle track underneath.
    col = mix(col, uTrack * 0.7, ring * 0.35);

    // Bright arc filled up to the current value, crisp leading edge.
    float v = uFrac[i];
    float arc = smoothstep(v + aaA, v - aaA, frac);
    col = mix(col, tint, ring * arc);
    // Soft additive glow so the filled arc reads as luminous, not flat.
    col += tint * ring * arc * 0.22;

    // Glowing rounded cap at the arc's leading tip.
    float ha = v * TAU;
    vec2 hp = vec2(sin(ha), cos(ha)) * radius;
    float cap = smoothstep(ht * 1.5 + aaR, ht * 1.5 - aaR, length(p - hp));
    col += mix(tint, uArc, 0.5) * cap * smoothstep(0.0, 0.02, v) * 0.9;
  }

  // Optional crisp hour ticks just outside the outer ring.
  if (uTicks > 0.5) {
    float tp = abs(fract(frac * 12.0) - 0.5) * 2.0;
    float aaT = fwidth(tp);
    float tick = smoothstep(0.85 - aaT, 0.85 + aaT, tp);
    float tickRing = smoothstep(ht * 0.9 + aaR, ht * 0.9 - aaR, abs(r - 0.45));
    col = mix(col, uArc, tick * tickRing * 0.7);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export class PolarClock implements Scene {
  readonly id = "polar-clock";
  readonly name = "Polar Clock";
  readonly description = "Concentric arcs tracking seconds → months in real time.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "thickness", label: "Ring Thickness", min: 0.01, max: 0.06, step: 0.005, default: 0.03 },
    { kind: "select", id: "ticks", label: "Hour Ticks", options: [
      { value: "on", label: "On" },
      { value: "off", label: "Off" },
    ], default: "on" },
    { kind: "select", id: "theme", label: "Theme", options: PALETTE_OPTIONS, default: "ocean" },
    { kind: "color", id: "arc", label: "Arc Color", default: "#6bd2e0" },
    { kind: "color", id: "track", label: "Track Color", default: "#0c5ca3" },
  ];

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private material: THREE.ShaderMaterial | null = null;
  private mesh: THREE.Mesh | null = null;

  init(_ctx: SceneContext): void {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uResolution: { value: new THREE.Vector2(1, 1) },
        uThickness: { value: 0.03 },
        uTicks: { value: 1 },
        uFrac: { value: [0, 0, 0, 0, 0] },
        uArc: { value: hexToColor("#6bd2e0") },
        uTrack: { value: hexToColor("#0c5ca3") },
        uBg: { value: hexToColor("#030e2e") },
      },
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  update(_time: number, _delta: number): void {
    if (!this.material) return;
    const now = new Date();
    const sec = (now.getSeconds() + now.getMilliseconds() / 1000) / 60;
    const min = (now.getMinutes() + sec) / 60;
    const hour = (now.getHours() + min) / 24;
    const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    const day = (now.getDate() - 1 + hour) / daysInMonth;
    const month = (now.getMonth() + day) / 12;
    this.material.uniforms.uFrac.value = [sec, min, hour, day, month];
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    (this.material?.uniforms.uResolution.value as THREE.Vector2)?.set(width, height);
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material?.uniforms;
    if (!u) return;
    switch (id) {
      case "thickness":
        u.uThickness.value = Number(value);
        break;
      case "ticks":
        u.uTicks.value = value === "on" ? 1 : 0;
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uBg.value as THREE.Color).set(p.a);
        (u.uTrack.value as THREE.Color).set(p.b);
        (u.uArc.value as THREE.Color).set(p.c);
        break;
      }
      case "arc":
        (u.uArc.value as THREE.Color).set(String(value));
        break;
      case "track":
        (u.uTrack.value as THREE.Color).set(String(value));
        break;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material?.dispose();
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = null;
  }
}
