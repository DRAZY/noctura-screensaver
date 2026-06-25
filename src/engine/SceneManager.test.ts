import { describe, expect, it } from "bun:test";
import * as THREE from "three";
import { SceneManager } from "./SceneManager";
import type { Parameter, ParameterValue, Scene, SceneContext } from "./types";

/** Records lifecycle calls so tests can assert on init/setParameter/etc. */
function fakeScene(id: string): Scene & { initCount: number; lastParam: [string, ParameterValue] | null } {
  return {
    id,
    name: id.toUpperCase(),
    description: "",
    parameters: [] as ReadonlyArray<Parameter>,
    initCount: 0,
    lastParam: null,
    init(_ctx: SceneContext) {
      this.initCount += 1;
    },
    update() {},
    render() {},
    resize() {},
    setParameter(pid: string, value: ParameterValue) {
      this.lastParam = [pid, value];
    },
    dispose() {},
  };
}

/** Minimal WebGLRenderer stand-in covering the methods SceneManager touches. */
function fakeRenderer(): THREE.WebGLRenderer {
  let pr = 1;
  return {
    setPixelRatio: (v: number) => {
      pr = v;
    },
    getPixelRatio: () => pr,
    setSize: () => {},
    setRenderTarget: () => {},
    render: () => {},
    setClearColor: () => {},
    clear: () => {},
    dispose: () => {},
  } as unknown as THREE.WebGLRenderer;
}

function makeManager() {
  let t = 0;
  const mgr = new SceneManager({} as HTMLCanvasElement, {
    createRenderer: () => fakeRenderer(),
    now: () => (t += 16),
  });
  return mgr;
}

describe("SceneManager", () => {
  it("registers scenes and lists them in order", () => {
    const mgr = makeManager();
    mgr.register(fakeScene("a"));
    mgr.register(fakeScene("b"));
    expect(mgr.list().map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("ignores duplicate registrations", () => {
    const mgr = makeManager();
    mgr.register(fakeScene("a"));
    mgr.register(fakeScene("a"));
    expect(mgr.list().length).toBe(1);
  });

  it("setActive initializes the scene once and reports the active id", () => {
    const mgr = makeManager();
    const a = fakeScene("a");
    const b = fakeScene("b");
    mgr.register(a);
    mgr.register(b);

    mgr.setActive("a");
    expect(mgr.getActiveId()).toBe("a");
    expect(a.initCount).toBe(1);

    mgr.setActive("b");
    mgr.setActive("a"); // back to a — must NOT re-init
    expect(a.initCount).toBe(1);
    expect(b.initCount).toBe(1);
  });

  it("setActive to the current id is a no-op", () => {
    const mgr = makeManager();
    const a = fakeScene("a");
    mgr.register(a);
    mgr.setActive("a");
    mgr.setActive("a");
    expect(a.initCount).toBe(1);
  });

  it("cycle advances and wraps in both directions", () => {
    const mgr = makeManager();
    ["a", "b", "c"].forEach((id) => mgr.register(fakeScene(id)));
    mgr.setActive("a");
    mgr.cycle(1);
    expect(mgr.getActiveId()).toBe("b");
    mgr.cycle(-1);
    expect(mgr.getActiveId()).toBe("a");
    mgr.cycle(-1); // wrap to last
    expect(mgr.getActiveId()).toBe("c");
  });

  it("setParameter forwards to the active scene only", () => {
    const mgr = makeManager();
    const a = fakeScene("a");
    const b = fakeScene("b");
    mgr.register(a);
    mgr.register(b);
    mgr.setActive("a");
    mgr.setParameter("speed", 0.5);
    expect(a.lastParam).toEqual(["speed", 0.5]);
    expect(b.lastParam).toBeNull();
  });
});

/** A scene that counts how many times it is rendered (for frame-gate tests). */
function countingScene(id: string): Scene & { renders: number } {
  return {
    id,
    name: id.toUpperCase(),
    description: "",
    parameters: [] as ReadonlyArray<Parameter>,
    renders: 0,
    init() {},
    update() {},
    render() {
      (this as unknown as { renders: number }).renders += 1;
    },
    resize() {},
    setParameter() {},
    dispose() {},
  } as unknown as Scene & { renders: number };
}

/**
 * Build a manager whose animation loop can be driven one frame at a time, with a
 * controllable clock. `tick(ms)` advances the clock and fires the captured rAF
 * callback once, simulating a display refresh `ms` after the previous one.
 */
function makeDrivable() {
  const clock = { t: 0 };
  let rafCb: FrameRequestCallback | null = null;
  const origRaf = globalThis.requestAnimationFrame;
  const origCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    rafCb = cb;
    return 1;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame;

  const mgr = new SceneManager({} as HTMLCanvasElement, {
    createRenderer: () => fakeRenderer(),
    now: () => clock.t,
  });
  const scene = countingScene("c");
  mgr.register(scene);
  mgr.setActive("c", { immediate: true });

  const tick = (ms: number) => {
    clock.t += ms;
    rafCb?.(clock.t);
  };
  const restore = () => {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancel;
  };
  return { mgr, scene, tick, restore };
}

const REFRESH = 1000 / 60; // one 60 Hz display-refresh interval, in ms

describe("SceneManager performance modes", () => {
  it("maps each fixed mode to the right quality scale and target fps", () => {
    const { mgr, restore } = makeDrivable();
    mgr.setPerformanceMode("full");
    expect(mgr.getQualityScale()).toBeCloseTo(2.0, 5);
    expect(mgr.getTargetFps()).toBe(60);
    mgr.setPerformanceMode("balanced");
    expect(mgr.getQualityScale()).toBeCloseTo(1.5, 5);
    expect(mgr.getTargetFps()).toBe(60);
    mgr.setPerformanceMode("power");
    expect(mgr.getQualityScale()).toBeCloseTo(1.0, 5);
    expect(mgr.getTargetFps()).toBe(30);
    restore();
  });

  it("renders every refresh at 60 fps but ~half as often at 30 fps", () => {
    const full = makeDrivable();
    full.mgr.setPerformanceMode("full");
    full.mgr.start();
    for (let i = 0; i < 30; i++) full.tick(REFRESH);
    full.restore();

    const power = makeDrivable();
    power.mgr.setPerformanceMode("power");
    power.mgr.start();
    for (let i = 0; i < 30; i++) power.tick(REFRESH);
    power.restore();

    expect(power.mgr.getTargetFps()).toBe(30);
    // 30 fps must render meaningfully fewer frames than 60 fps over the same span.
    expect(full.scene.renders).toBeGreaterThan(power.scene.renders * 1.5);
  });

  it("Auto lowers quality under sustained slow frames, then drops to 30 fps at the floor", () => {
    const { mgr, tick, restore } = makeDrivable();
    mgr.setPerformanceMode("auto");
    expect(mgr.getQualityScale()).toBeCloseTo(1.5, 5);
    expect(mgr.getTargetFps()).toBe(60);
    mgr.start();
    // Frames arriving every 40 ms = badly GPU-bound for a 60 fps budget.
    for (let i = 0; i < 400; i++) tick(40);
    restore();
    expect(mgr.getQualityScale()).toBeLessThan(1.5);
    expect(mgr.getQualityScale()).toBeCloseTo(1.0, 3); // hit the resolution floor
    expect(mgr.getTargetFps()).toBe(30); // then fell back to 30 fps
  });

  it("Auto climbs back toward full quality once frames are comfortably fast", () => {
    const { mgr, tick, restore } = makeDrivable();
    mgr.setPerformanceMode("auto");
    mgr.start();
    for (let i = 0; i < 200; i++) tick(40); // degrade first
    const degraded = mgr.getQualityScale();
    expect(degraded).toBeLessThan(1.5);

    for (let i = 0; i < 1200; i++) tick(REFRESH); // then feed fast frames
    restore();
    expect(mgr.getTargetFps()).toBe(60);
    expect(mgr.getQualityScale()).toBeGreaterThan(degraded);
  });

  it("does not adapt while a fixed mode is selected", () => {
    const { mgr, tick, restore } = makeDrivable();
    mgr.setPerformanceMode("full");
    mgr.start();
    for (let i = 0; i < 200; i++) tick(40); // would trip Auto, but mode is fixed
    restore();
    expect(mgr.getQualityScale()).toBeCloseTo(2.0, 5);
    expect(mgr.getTargetFps()).toBe(60);
  });
});
