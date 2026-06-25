import * as THREE from "three";
import type { Parameter, ParameterValue, Scene, SceneContext } from "../engine/types";

/**
 * Base class for scenes that are a single full-viewport fragment shader (the
 * gradient, nebula, and ribbon scenes). Handles the boilerplate every such
 * scene shares — an orthographic camera, a 2×2 quad, a `uTime`/`uResolution`
 * uniform contract, and render-to-target plumbing — so subclasses only supply
 * `createMaterial()` and `setParameter()`.
 */
export abstract class FullscreenScene implements Scene {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly parameters: ReadonlyArray<Parameter>;

  protected readonly scene = new THREE.Scene();
  protected readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  protected material!: THREE.ShaderMaterial;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private mesh: THREE.Mesh | null = null;

  /** Subclasses build their ShaderMaterial here (uniforms must include `uTime`). */
  protected abstract createMaterial(): THREE.ShaderMaterial;

  init(_ctx: SceneContext): void {
    this.material = this.createMaterial();
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.scene.add(this.mesh);
  }

  update(time: number, _delta: number): void {
    const u = this.material.uniforms.uTime;
    if (u) u.value = time;
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null): void {
    renderer.setRenderTarget(target);
    renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    const u = this.material?.uniforms.uResolution;
    if (u) (u.value as THREE.Vector2).set(width, height);
  }

  abstract setParameter(id: string, value: ParameterValue): void;

  dispose(): void {
    this.geometry.dispose();
    this.material?.dispose();
    if (this.mesh) this.scene.remove(this.mesh);
    this.mesh = null;
  }
}
