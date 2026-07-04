import * as THREE from "three";
import type { ParameterValue, Scene, SceneContext } from "../engine/types";
import { hexToColor, paletteById } from "../engine/palette";
import { CURL_NOISE, SIMPLEX_3D } from "../engine/shaders/noise.glsl";
import { NATIVE_PARAMETERS, remapSpeed, remapSize } from "../engine/sceneParams";

/**
 * Flowing particles (Drift aesthetic): tens of thousands of luminous points
 * advected through a curl-noise flow field. Motion is computed statelessly in
 * the vertex shader — each point's seed position is displaced by curl noise
 * sampled at `seed + time`, so there's zero per-frame CPU work and no GPGPU
 * ping-pong. Additive blending + soft round sprites give a glowing, smoky look.
 */

const MAX_PARTICLES = 60000;

const VERT = /* glsl */ `
precision highp float;
attribute vec3 seed;
attribute float rnd;
uniform float uTime;
uniform float uSpeed;
uniform float uScale;
uniform float uSize;
uniform vec3  uColorA;
uniform vec3  uColorB;
varying float vGlow;
varying vec3  vColor;

${SIMPLEX_3D}
${CURL_NOISE}

void main() {
  float t = uTime * uSpeed;
  // Two-octave curl displacement → organic, divergence-free flow.
  vec3 flow = curlNoise(seed * uScale + vec3(0.0, 0.0, t * 0.15));
  flow += 0.5 * curlNoise(seed * uScale * 2.3 + vec3(t * 0.1, 5.0, 0.0));
  vec3 pos = seed + flow * 0.6 + vec3(0.0, sin(t * 0.2 + rnd * 6.28) * 0.1, 0.0);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * (1.0 + rnd) * (3.0 / max(-mv.z, 0.1));

  vGlow = 0.4 + 0.6 * rnd;
  vColor = mix(uColorA, uColorB, clamp(length(flow) * 0.8, 0.0, 1.0));
}
`;

const FRAG = /* glsl */ `
precision highp float;
varying float vGlow;
varying vec3  vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float core = smoothstep(0.5, 0.0, d);
  // Bright core + soft halo for a luminous, additive bloom.
  float halo = smoothstep(0.5, 0.15, d);
  gl_FragColor = vec4(vColor * vGlow * (1.6 * core + 0.5 * halo), core * core);
}
`;

export class FlowingParticles implements Scene {
  readonly id = "flowing-particles";
  readonly name = "Particle Drift";
  readonly description = "Luminous points streaming through a curl-noise flow.";

  readonly parameters = NATIVE_PARAMETERS;

  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  private geometry: THREE.BufferGeometry | null = null;
  private material: THREE.ShaderMaterial | null = null;
  private points: THREE.Points | null = null;

  init(_ctx: SceneContext): void {
    this.camera.position.set(0, 0, 3.2);
    this.camera.lookAt(0, 0, 0);

    const seeds = new Float32Array(MAX_PARTICLES * 3);
    const rnds = new Float32Array(MAX_PARTICLES);
    // Deterministic pseudo-random fill (no Math.random — keeps it reproducible
    // and avoids the banned RNG in restricted contexts).
    let s = 0x2545f491;
    const rand = () => {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      return ((s >>> 0) % 100000) / 100000;
    };
    for (let i = 0; i < MAX_PARTICLES; i++) {
      seeds[i * 3 + 0] = (rand() - 0.5) * 3.0;
      seeds[i * 3 + 1] = (rand() - 0.5) * 3.0;
      seeds[i * 3 + 2] = (rand() - 0.5) * 3.0;
      rnds[i] = rand();
    }

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
    this.geometry.setAttribute("seed", new THREE.BufferAttribute(seeds, 3));
    this.geometry.setAttribute("rnd", new THREE.BufferAttribute(rnds, 1));
    this.geometry.setDrawRange(0, Math.floor(MAX_PARTICLES * 0.8));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: 0.85 },
        uScale: { value: 1.0 },
        uSize: { value: 3.4 },
        uColorA: { value: hexToColor("#d91c8f") },
        uColorB: { value: hexToColor("#2ec2eb") },
      },
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
  }

  update(time: number, _delta: number): void {
    if (this.material) this.material.uniforms.uTime.value = time;
    this.points!.rotation.y = time * 0.03;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x02030a, 1);
    renderer.clear();
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(height, 1);
    this.camera.updateProjectionMatrix();
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material?.uniforms;
    if (!u) return;
    switch (id) {
      case "speed":
        u.uSpeed.value = remapSpeed(Number(value), 0.85);
        break;
      case "density":
        this.geometry?.setDrawRange(0, Math.floor(MAX_PARTICLES * Math.min(Math.max(Number(value), 0), 1)));
        break;
      case "size":
        u.uSize.value = remapSize(Number(value), 3.4);
        break;
      case "theme": {
        const p = paletteById(String(value));
        (u.uColorA.value as THREE.Color).set(p.b);
        (u.uColorB.value as THREE.Color).set(p.c);
        break;
      }
    }
  }

  dispose(): void {
    this.geometry?.dispose();
    this.material?.dispose();
    if (this.points) this.scene.remove(this.points);
    this.points = null;
  }
}
