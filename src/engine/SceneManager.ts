import * as THREE from "three";
import { computeFps } from "../ui/fps";
import type { Parameter, ParameterValue, PerformanceMode, Scene, SceneContext } from "./types";

/**
 * Owns the single `THREE.WebGLRenderer`, the animation loop, and scene
 * lifecycle. Scenes register once; `setActive` crossfades from the current
 * scene to the next by rendering both to offscreen targets and blending them
 * with a fullscreen mix shader over {@link CROSSFADE_SECONDS}. In steady state
 * (no transition) the active scene renders straight to the screen for
 * efficiency.
 */

export const CROSSFADE_SECONDS = 0.8;

export interface SceneManagerOptions {
  maxPixelRatio?: number;
  createRenderer?: (canvas: HTMLCanvasElement) => THREE.WebGLRenderer;
  now?: () => number;
  onFrame?: (fps: number) => void;
}

const DEFAULT_MAX_PIXEL_RATIO = 2;

/**
 * Fixed render-scale ceiling and target frame rate for each non-adaptive
 * performance mode, plus the bounds Auto operates within. The scale is a cap on
 * the effective pixel ratio (combined with DPR and the surface-size limit), so
 * `full` ≈ native, `balanced` ≈ 44% fewer pixels, `power` ≈ quarter pixels at
 * 30 fps. These mirror the native saver's profiles.
 */
const PERF_PROFILE: Record<PerformanceMode, { scale: number; fps: number }> = {
  auto: { scale: 2.0, fps: 60 }, // ceiling; Auto moves between AUTO_MIN_SCALE..scale
  full: { scale: 2.0, fps: 60 },
  balanced: { scale: 1.5, fps: 60 },
  power: { scale: 1.0, fps: 30 },
};
const AUTO_MIN_SCALE = 1.0; // Auto won't drop resolution below this before cutting fps.

/**
 * Hard battery / low-power clamp. A screensaver is the one thing guaranteed to
 * run for hours unattended — exactly when the user isn't watching the battery —
 * so on battery power we cap the effective profile to at most this render scale
 * and this frame rate, on top of whatever mode the user picked. On this
 * (DPR-relative) engine a scale of 1.0 is a good non-supersampled floor, down
 * from the 2.0 Retina ceiling. The cap is released the instant AC power returns.
 */
const POWER_SAVE_MAX_SCALE = 1.0;
const POWER_SAVE_MAX_FPS = 30;

/**
 * Largest drawing-buffer edge we allow. WebKit/WKWebView (the macOS Tauri
 * webview) composites a WebGL canvas as a single GPU surface only up to roughly
 * this size; beyond it the surface is split into tiles that refresh slightly out
 * of sync, producing a hard horizontal seam on animated content. Keeping the
 * backing store at or under this bound — by lowering the effective pixel ratio
 * on large/4K/5K displays — keeps the canvas in one tile and removes the seam.
 */
const MAX_SURFACE_DIM = 4096;

const BLEND_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const BLEND_FRAG = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
void main() {
  vec4 a = texture2D(uFrom, vUv);
  vec4 b = texture2D(uTo, vUv);
  gl_FragColor = mix(a, b, clamp(uMix, 0.0, 1.0));
}
`;

export class SceneManager {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly maxPixelRatio: number;
  private readonly now: () => number;
  private readonly onFrame?: (fps: number) => void;

  private readonly scenes = new Map<string, Scene>();
  private readonly order: string[] = [];
  private activeId: string | null = null;

  private width = 1;
  private height = 1;
  private running = false;
  // Render-pause state. When the window/tab is hidden we stop issuing frames
  // entirely (a screensaver no one can see should cost zero GPU). Browsers
  // already throttle rAF for hidden tabs, but WKWebView/Tauri may not — this
  // makes the behavior explicit and frees the GPU when occluded.
  private paused = false;
  private pausedAt = 0;
  private rafId: number | null = null;
  private startTime = 0;
  private lastTime = 0;
  private sceneStart = 0;

  // Crossfade state.
  private transition: { from: Scene; to: Scene; t: number } | null = null;
  private targetA: THREE.WebGLRenderTarget;
  private targetB: THREE.WebGLRenderTarget;
  private readonly blendScene = new THREE.Scene();
  private readonly blendCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly blendMaterial: THREE.ShaderMaterial;

  // FPS sampling.
  private frameCount = 0;
  private fpsClock = 0;

  // Performance / adaptive quality.
  private performanceMode: PerformanceMode = "auto";
  // True while the machine is on battery (or an OS low-power mode). Folds a hard
  // ceiling into every effective scale/frame-rate computation; see setPowerSave.
  private powerSave = false;
  // Current ceiling on the effective pixel ratio (set by the mode; in Auto this
  // is the live adaptive value). Folded into effectivePixelRatio().
  private qualityCap = PERF_PROFILE.auto.scale;
  // Target frame interval in ms (60 → ~16.7, 30 → ~33.3). Frames are gated to
  // this in the loop so "30 fps" modes actually halve GPU work, not just cap fps.
  private targetFrameMs = 1000 / 60;
  // Wall-time accumulated since the last *rendered* frame (drives the gate).
  private frameAccumMs = 0;
  // Auto-mode adaptive state.
  private autoScale = 1.5; // current Auto render scale, within [AUTO_MIN_SCALE, ceiling]
  private autoAt60 = true; // whether Auto is currently targeting 60 (vs 30) fps
  private smoothedFrameMs = 0; // EWMA of rendered-frame wall time
  private framesSinceAdapt = 0;
  private slowStreak = 0; // consecutive evaluations over budget
  private stableStreak = 0; // consecutive evaluations comfortably under budget

  constructor(canvas: HTMLCanvasElement, options: SceneManagerOptions = {}) {
    this.maxPixelRatio = options.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;
    this.now = options.now ?? (() => performance.now());
    this.onFrame = options.onFrame;

    this.renderer =
      options.createRenderer?.(canvas) ??
      new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "high-performance" });

    this.renderer.setPixelRatio(this.effectivePixelRatio(this.width, this.height));

    this.targetA = this.makeTarget(1, 1);
    this.targetB = this.makeTarget(1, 1);
    this.blendMaterial = new THREE.ShaderMaterial({
      vertexShader: BLEND_VERT,
      fragmentShader: BLEND_FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFrom: { value: this.targetA.texture },
        uTo: { value: this.targetB.texture },
        uMix: { value: 0 },
      },
    });
    this.blendScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blendMaterial));

    if (typeof window !== "undefined") {
      window.addEventListener("resize", this.handleResize);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
  }

  /** Pause rendering while hidden, resume (seamlessly) when shown again. */
  private readonly onVisibility = (): void => {
    if (typeof document === "undefined") return;
    if (document.hidden) this.pauseRendering();
    else this.resumeRendering();
  };

  private pauseRendering(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.pausedAt = this.now();
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private resumeRendering(): void {
    if (!this.running || !this.paused) return;
    // Shift the scene clock forward by the hidden duration so the animation
    // resumes exactly where it left off instead of jumping ahead by the gap.
    const gap = this.now() - this.pausedAt;
    this.sceneStart += gap;
    this.startTime += gap;
    this.lastTime = this.now();
    this.frameAccumMs = 0;
    this.smoothedFrameMs = 0; // don't let the long gap read as a slow frame
    this.paused = false;
    this.loop();
  }

  /**
   * Pixel ratio to render at for the given CSS viewport: the display's DPR,
   * clamped to {@link maxPixelRatio}, and further reduced so the resulting
   * drawing buffer never exceeds {@link MAX_SURFACE_DIM} on its longest edge
   * (which would force WKWebView to tile the canvas and tear it).
   */
  private effectivePixelRatio(width: number, height: number): number {
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    let pr = Math.min(Math.max(dpr, 1), this.maxPixelRatio);
    // Performance-mode / adaptive ceiling: the #1 GPU lever, exactly like the
    // native saver capping its Metal drawable scale.
    pr = Math.min(pr, this.qualityCap);
    const longest = Math.max(width, height, 1);
    if (longest * pr > MAX_SURFACE_DIM) pr = MAX_SURFACE_DIM / longest;
    // Never go below 1 CSS px per device px on normal displays; on very large
    // ones we accept a slightly soft buffer to stay seam-free.
    return Math.max(0.75, pr);
  }

  /**
   * Re-apply the current effective pixel ratio to the renderer and the crossfade
   * targets. Called on resize and whenever the performance mode / adaptive scale
   * changes. Does not touch per-scene resize (geometry is CSS-pixel based).
   */
  private applyPixelRatio(): void {
    this.renderer.setPixelRatio(this.effectivePixelRatio(this.width, this.height));
    this.renderer.setSize(this.width, this.height, false);
    const pr = this.renderer.getPixelRatio();
    const bw = Math.floor(this.width * pr);
    const bh = Math.floor(this.height * pr);
    this.targetA.setSize(bw, bh);
    this.targetB.setSize(bw, bh);
  }

  /**
   * Select a render-cost profile. Fixed modes pin a resolution cap + frame rate;
   * `auto` hands control to the adaptive loop (which moves the cap between
   * {@link AUTO_MIN_SCALE} and the ceiling based on measured frame time, then
   * drops to 30 fps only if even the floor can't hold 60).
   */
  setPerformanceMode(mode: PerformanceMode): void {
    this.performanceMode = mode;
    const profile = PERF_PROFILE[mode];
    if (mode === "auto") {
      // Re-seed Auto so it converges fresh against the current scene/GPU. The
      // ceiling folds in the battery clamp, and on battery we pin the cadence to
      // 30 fps up front (Auto then only adapts resolution within the cap).
      this.autoScale = Math.min(1.5, this.autoCeiling());
      this.autoAt60 = !this.powerSave;
      this.smoothedFrameMs = 0;
      this.framesSinceAdapt = 0;
      this.slowStreak = 0;
      this.stableStreak = 0;
      this.qualityCap = this.autoScale;
      this.targetFrameMs = this.autoAt60 ? 1000 / 60 : 1000 / 30;
    } else {
      this.qualityCap = this.clampScale(profile.scale);
      this.targetFrameMs = this.clampFrameMs(1000 / profile.fps);
    }
    this.frameAccumMs = 0;
    this.applyPixelRatio();
  }

  getPerformanceMode(): PerformanceMode {
    return this.performanceMode;
  }

  /**
   * Report the current power source. On battery (or an OS low-power mode) the
   * effective profile is hard-capped to {@link POWER_SAVE_MAX_SCALE} /
   * {@link POWER_SAVE_MAX_FPS} on top of whatever mode the user chose; on AC the
   * cap is released. Re-seeds the active mode so the change takes effect at once
   * (and Auto reconverges against the new ceiling). Idempotent.
   */
  setPowerSave(active: boolean): void {
    if (active === this.powerSave) return;
    this.powerSave = active;
    this.setPerformanceMode(this.performanceMode);
  }

  /** Whether the battery/low-power clamp is currently in effect. Diagnostics/tests. */
  getPowerSave(): boolean {
    return this.powerSave;
  }

  /** Render-scale ceiling Auto may climb to, folding in the battery clamp. */
  private autoCeiling(): number {
    return this.clampScale(PERF_PROFILE.auto.scale);
  }

  /** Cap a render scale by the battery clamp (no-op on AC). */
  private clampScale(scale: number): number {
    return this.powerSave ? Math.min(scale, POWER_SAVE_MAX_SCALE) : scale;
  }

  /** Floor a target frame interval by the battery clamp (no-op on AC). */
  private clampFrameMs(ms: number): number {
    return this.powerSave ? Math.max(ms, 1000 / POWER_SAVE_MAX_FPS) : ms;
  }

  /** Current effective render-scale ceiling (≈1.0–2.0). Diagnostics / HUD / tests. */
  getQualityScale(): number {
    return this.qualityCap;
  }

  /** Current target frame rate in fps (60 or 30). Diagnostics / HUD / tests. */
  getTargetFps(): number {
    return Math.round(1000 / this.targetFrameMs);
  }

  private makeTarget(w: number, h: number): THREE.WebGLRenderTarget {
    const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    return t;
  }

  /** Register a scene. The first registered scene becomes the default active one. */
  register(scene: Scene): void {
    if (this.scenes.has(scene.id)) return;
    this.scenes.set(scene.id, scene);
    this.order.push(scene.id);
  }

  /** All registered scenes in registration order (for the picker). */
  list(): Scene[] {
    return this.order.map((id) => this.scenes.get(id)!);
  }

  getActive(): Scene | null {
    return this.activeId ? (this.scenes.get(this.activeId) ?? null) : null;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /**
   * Switch to scene `id`. If a scene is already active and differs, crossfade;
   * otherwise activate immediately. Unknown ids are ignored.
   */
  setActive(id: string, opts: { immediate?: boolean } = {}): void {
    const next = this.scenes.get(id);
    if (!next || id === this.activeId) return;

    const ctx: SceneContext = { renderer: this.renderer, width: this.width, height: this.height };
    if (!this.isInitialized(next)) {
      next.init(ctx);
      next.resize(this.width, this.height);
    }

    const current = this.getActive();
    this.activeId = id;
    this.sceneStart = this.now();

    if (current && !opts.immediate) {
      this.transition = { from: current, to: next, t: 0 };
    } else {
      this.transition = null;
    }
  }

  /** Cycle to the next/previous registered scene (dev keybind / shuffle). */
  cycle(direction: 1 | -1): void {
    if (this.order.length < 2 || this.activeId === null) return;
    const idx = this.order.indexOf(this.activeId);
    const nextIdx = (idx + direction + this.order.length) % this.order.length;
    this.setActive(this.order[nextIdx]);
  }

  /** Forward a parameter change to the active scene. */
  setParameter(id: string, value: ParameterValue): void {
    this.getActive()?.setParameter(id, value);
  }

  /** Parameter schema of the active scene (for the controls UI). */
  activeParameters(): ReadonlyArray<Parameter> {
    return this.getActive()?.parameters ?? [];
  }

  private readonly initialized = new WeakSet<Scene>();
  private isInitialized(scene: Scene): boolean {
    if (this.initialized.has(scene)) return true;
    this.initialized.add(scene);
    return false;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startTime = this.now();
    this.lastTime = this.startTime;
    if (this.sceneStart === 0) this.sceneStart = this.startTime;
    this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private readonly loop = (): void => {
    if (!this.running || this.paused) return;
    const current = this.now();
    // Raw interval between display-refresh callbacks. This — not the rendered
    // delta — is the load signal: rAF fires every refresh regardless of our
    // render gate, so a GPU-bound stall shows up here as a widened interval,
    // while the deliberate frame-skip at 30 fps does not pollute it.
    const rafInterval = current - this.lastTime;
    this.lastTime = current;
    this.frameAccumMs += rafInterval;
    this.adaptIfNeeded(rafInterval);

    // Gate rendering to the target frame interval. requestAnimationFrame fires at
    // the display rate (~60 Hz); a 30 fps target renders every other callback, so
    // the GPU genuinely does half the work rather than just reporting a lower fps.
    // The small tolerance keeps a 60 fps target rendering every frame instead of
    // beating against sub-millisecond rAF jitter.
    if (this.frameAccumMs + 1 >= this.targetFrameMs) {
      const delta = this.frameAccumMs / 1000;
      this.frameAccumMs = 0;
      this.renderFrame(delta);
      this.sampleFps(delta);
    }

    if (this.running && typeof requestAnimationFrame !== "undefined") {
      this.rafId = requestAnimationFrame(this.loop);
    }
  };

  /**
   * Auto-mode quality controller. WebGL gives no GPU clock in WKWebView, so this
   * works off the display-refresh interval: vsync pins it near the refresh period
   * when the GPU keeps up, and widens it (dropped frames) when GPU-bound. We
   * therefore *lower* the render scale on a sustained overrun, and — since spare
   * headroom is invisible while vsync caps us — *probe upward* after a long stable
   * stretch, backing off again if the probe regresses. Resolution moves first;
   * frame rate (60→30) is the last resort once the resolution floor still can't
   * hold the budget.
   */
  private adaptIfNeeded(frameMs: number): void {
    if (this.performanceMode !== "auto" || frameMs <= 0) return;
    this.smoothedFrameMs = this.smoothedFrameMs === 0 ? frameMs : this.smoothedFrameMs * 0.9 + frameMs * 0.1;
    this.framesSinceAdapt += 1;

    const budget = this.targetFrameMs;
    if (this.smoothedFrameMs > budget * 1.25) {
      this.slowStreak += 1;
      this.stableStreak = 0;
    } else if (this.smoothedFrameMs < budget * 1.1) {
      this.stableStreak += 1;
      this.slowStreak = 0;
    } else {
      this.slowStreak = 0;
      this.stableStreak = 0;
    }

    // Re-evaluate at most a few times per second so changes settle and the
    // backing store isn't resized every frame.
    if (this.framesSinceAdapt < 20) return;

    if (this.slowStreak >= 12) {
      this.stepAutoDown();
    } else if (this.stableStreak >= 150) {
      this.stepAutoUp();
    }
  }

  private stepAutoDown(): void {
    const target = Math.max(this.autoScale * 0.85, AUTO_MIN_SCALE);
    if (target < this.autoScale - 0.001) {
      this.autoScale = target;
    } else if (this.autoAt60) {
      this.autoAt60 = false;
      this.targetFrameMs = 1000 / 30;
    } else {
      this.resetAdaptCounters();
      return; // already at the floor on both axes
    }
    this.qualityCap = this.autoScale;
    this.resetAdaptCounters();
    this.applyPixelRatio();
  }

  private stepAutoUp(): void {
    const ceiling = this.autoCeiling();
    // On battery the cadence stays pinned at 30 fps — never probe back to 60.
    if (!this.autoAt60 && !this.powerSave) {
      this.autoAt60 = true;
      this.targetFrameMs = 1000 / 60;
    } else if (this.autoScale < ceiling - 0.001) {
      this.autoScale = Math.min(this.autoScale * 1.12 + 0.05, ceiling);
    } else {
      this.resetAdaptCounters();
      return; // already at native 60 fps
    }
    this.qualityCap = this.autoScale;
    this.resetAdaptCounters();
    this.applyPixelRatio();
  }

  private resetAdaptCounters(): void {
    this.framesSinceAdapt = 0;
    this.slowStreak = 0;
    this.stableStreak = 0;
    this.smoothedFrameMs = 0; // scale/rate changed → old samples are stale
  }

  private renderFrame(delta: number): void {
    const active = this.getActive();
    if (!active) return;

    if (this.transition) {
      const { from, to } = this.transition;
      this.transition.t += delta / CROSSFADE_SECONDS;

      from.update((this.now() - this.sceneStart) / 1000, delta);
      to.update((this.now() - this.sceneStart) / 1000, delta);

      from.render(this.renderer, this.targetA);
      to.render(this.renderer, this.targetB);

      this.blendMaterial.uniforms.uFrom.value = this.targetA.texture;
      this.blendMaterial.uniforms.uTo.value = this.targetB.texture;
      this.blendMaterial.uniforms.uMix.value = this.transition.t;

      this.renderer.setRenderTarget(null);
      this.renderer.render(this.blendScene, this.blendCamera);

      if (this.transition.t >= 1) this.transition = null;
      return;
    }

    active.update((this.now() - this.sceneStart) / 1000, delta);
    active.render(this.renderer, null);
  }

  private sampleFps(delta: number): void {
    if (!this.onFrame) return;
    this.frameCount += 1;
    this.fpsClock += delta;
    if (this.fpsClock >= 1) {
      this.onFrame(computeFps(this.frameCount, this.fpsClock));
      this.frameCount = 0;
      this.fpsClock = 0;
    }
  }

  private readonly handleResize = (): void => {
    const w = typeof window !== "undefined" ? window.innerWidth : this.width;
    const h = typeof window !== "undefined" ? window.innerHeight : this.height;
    this.resize(w, h);
  };

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // Recompute the safe pixel ratio for the new viewport before sizing so the
    // backing store stays within the single-surface limit (no tile seam).
    this.applyPixelRatio();

    for (const id of this.order) {
      const s = this.scenes.get(id)!;
      if (this.initialized.has(s)) s.resize(this.width, this.height);
    }
  }

  dispose(): void {
    this.stop();
    if (typeof window !== "undefined") {
      window.removeEventListener("resize", this.handleResize);
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    for (const id of this.order) {
      const s = this.scenes.get(id)!;
      if (this.initialized.has(s)) s.dispose();
    }
    this.targetA.dispose();
    this.targetB.dispose();
    this.blendMaterial.dispose();
    this.renderer.dispose();
  }
}
