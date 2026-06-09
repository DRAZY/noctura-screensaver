import * as THREE from "three";

/**
 * A renderable scene is anything that owns a full-viewport material and knows
 * how to advance itself one frame. Scenes are intentionally decoupled from the
 * Renderer so different visuals (gradients, particle fields, etc.) can be
 * swapped in without touching the render loop.
 */
export interface RenderScene {
  /** Material drawn on the fullscreen quad. */
  readonly material: THREE.Material;
  /**
   * Advance the scene one frame.
   * @param elapsed seconds since the loop started
   * @param delta seconds since the previous frame
   */
  update(elapsed: number, delta: number): void;
  /** Optional resize hook (e.g. to update a uResolution uniform). */
  resize?(width: number, height: number): void;
  /** Release any GPU resources the scene owns. */
  dispose?(): void;
}

/**
 * Minimal structural type covering the parts of `THREE.WebGLRenderer` the
 * Renderer relies on. Declaring it explicitly keeps the render loop testable:
 * a fake implementation can be injected without a real WebGL context.
 */
export interface GLRenderer {
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: THREE.Object3D, camera: THREE.Camera): void;
  dispose(): void;
}

export interface RendererOptions {
  /** Cap device-pixel-ratio for idle efficiency. Defaults to 2. */
  maxPixelRatio?: number;
  /** Factory for the underlying GL renderer. Overridable for tests. */
  createRenderer?: (canvas: HTMLCanvasElement) => GLRenderer;
  /** Monotonic clock in milliseconds. Defaults to `performance.now`. */
  now?: () => number;
  /**
   * Called once per rendered frame with the same elapsed/delta the active scene
   * receives. Useful for lightweight instrumentation (e.g. an FPS overlay)
   * without coupling the loop to the UI.
   */
  onFrame?: (elapsed: number, delta: number) => void;
}

/** Clamp a device-pixel-ratio into the `[1, max]` range. */
export function clampPixelRatio(dpr: number, max: number): number {
  if (!Number.isFinite(dpr) || dpr < 1) return 1;
  return Math.min(dpr, max);
}

const DEFAULT_MAX_PIXEL_RATIO = 2;

function defaultCreateRenderer(canvas: HTMLCanvasElement): GLRenderer {
  return new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: "high-performance",
  });
}

/**
 * Wraps a Three.js `WebGLRenderer` driving a single full-viewport quad through
 * an orthographic camera — the standard fullscreen-shader pattern. Exposes a
 * clean `start()` / `stop()` / `dispose()` lifecycle and a `requestAnimationFrame`
 * loop that feeds elapsed time + delta to the active scene.
 */
export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly maxPixelRatio: number;
  private readonly now: () => number;
  private readonly onFrame?: (elapsed: number, delta: number) => void;

  private readonly gl: GLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.OrthographicCamera;
  private readonly quad: THREE.Mesh;
  private readonly geometry: THREE.PlaneGeometry;
  private readonly placeholderMaterial: THREE.Material;

  private activeScene: RenderScene | null = null;
  private rafId: number | null = null;
  private running = false;
  private startTime = 0;
  private lastTime = 0;
  private width = 0;
  private height = 0;
  private disposed = false;

  private readonly onWindowResize = (): void => this.handleResize();
  private readonly tick = (): void => this.frame();

  constructor(canvas: HTMLCanvasElement, options: RendererOptions = {}) {
    this.canvas = canvas;
    this.maxPixelRatio = options.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;
    this.now = options.now ?? (() => performance.now());
    this.onFrame = options.onFrame;

    const create = options.createRenderer ?? defaultCreateRenderer;
    this.gl = create(canvas);

    // Orthographic camera with a [-1, 1] frustum so a 2x2 plane exactly fills
    // the viewport regardless of aspect ratio.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();

    this.geometry = new THREE.PlaneGeometry(2, 2);
    this.placeholderMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.quad = new THREE.Mesh(this.geometry, this.placeholderMaterial);
    this.scene.add(this.quad);

    this.handleResize();

    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.onWindowResize);
    }
  }

  /** Install a scene; its material becomes the fullscreen quad's surface. */
  setScene(scene: RenderScene): void {
    this.activeScene = scene;
    this.quad.material = scene.material;
    if (scene.resize && this.width > 0 && this.height > 0) {
      scene.resize(this.width, this.height);
    }
  }

  /** Begin the animation loop. Idempotent. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.startTime = this.now();
    this.lastTime = this.startTime;
    this.scheduleNext();
  }

  /** Pause the animation loop without releasing GPU resources. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      if (typeof cancelAnimationFrame !== "undefined") {
        cancelAnimationFrame(this.rafId);
      }
      this.rafId = null;
    }
  }

  /** Stop the loop and release all GPU + DOM resources. */
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;

    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.onWindowResize);
    }

    this.activeScene?.dispose?.();
    this.activeScene = null;

    this.geometry.dispose();
    this.placeholderMaterial.dispose();
    this.gl.dispose();
  }

  /** Resize the drawing buffer to match the canvas/viewport. */
  handleResize(): void {
    const w = this.viewportWidth();
    const h = this.viewportHeight();
    if (w === this.width && h === this.height) return;

    this.width = w;
    this.height = h;

    const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
    this.gl.setPixelRatio(clampPixelRatio(dpr ?? 1, this.maxPixelRatio));
    this.gl.setSize(w, h, false);
    this.activeScene?.resize?.(w, h);
  }

  /** Advance and render exactly one frame using the injected clock. */
  frame(): void {
    if (!this.running) return;

    const current = this.now();
    const elapsed = (current - this.startTime) / 1000;
    const delta = (current - this.lastTime) / 1000;
    this.lastTime = current;

    this.activeScene?.update(elapsed, delta);
    this.gl.render(this.scene, this.camera);
    this.onFrame?.(elapsed, delta);

    if (this.running) this.scheduleNext();
  }

  private scheduleNext(): void {
    if (typeof requestAnimationFrame !== "undefined") {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private viewportWidth(): number {
    return this.canvas.clientWidth || (typeof window !== "undefined" ? window.innerWidth : 0);
  }

  private viewportHeight(): number {
    return this.canvas.clientHeight || (typeof window !== "undefined" ? window.innerHeight : 0);
  }
}
