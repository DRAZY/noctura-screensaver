import { describe, expect, mock, test } from "bun:test";
import * as THREE from "three";
import { clampPixelRatio, Renderer, type GLRenderer, type RenderScene } from "./Renderer";

/** A fake GL renderer that records calls without needing a WebGL context. */
function makeFakeGL() {
  const calls = {
    setPixelRatio: [] as number[],
    setSize: [] as Array<[number, number]>,
    render: 0,
    dispose: 0,
  };
  const gl: GLRenderer = {
    setPixelRatio: (v) => calls.setPixelRatio.push(v),
    setSize: (w, h) => calls.setSize.push([w, h]),
    render: () => {
      calls.render += 1;
    },
    dispose: () => {
      calls.dispose += 1;
    },
  };
  return { gl, calls };
}

/** Minimal canvas stand-in exposing the fields the Renderer reads. */
function makeCanvas(width = 1920, height = 1080): HTMLCanvasElement {
  return { clientWidth: width, clientHeight: height } as unknown as HTMLCanvasElement;
}

function makeScene(): RenderScene & { updates: Array<[number, number]>; resizes: Array<[number, number]> } {
  const updates: Array<[number, number]> = [];
  const resizes: Array<[number, number]> = [];
  return {
    material: new THREE.MeshBasicMaterial(),
    updates,
    resizes,
    update: (elapsed, delta) => updates.push([elapsed, delta]),
    resize: (w, h) => resizes.push([w, h]),
    dispose: mock(() => {}),
  };
}

describe("clampPixelRatio", () => {
  test("caps high-DPR displays at the max", () => {
    expect(clampPixelRatio(3, 2)).toBe(2);
  });

  test("passes through ratios below the cap", () => {
    expect(clampPixelRatio(1.5, 2)).toBe(1.5);
  });

  test("floors sub-1 and non-finite values to 1", () => {
    expect(clampPixelRatio(0.5, 2)).toBe(1);
    expect(clampPixelRatio(NaN, 2)).toBe(1);
    expect(clampPixelRatio(Infinity, 2)).toBe(1);
  });
});

describe("Renderer", () => {
  test("sizes the GL buffer to the canvas on construction", () => {
    const { gl, calls } = makeFakeGL();
    new Renderer(makeCanvas(800, 600), { createRenderer: () => gl, now: () => 0 });
    expect(calls.setSize.at(-1)).toEqual([800, 600]);
    expect(calls.setPixelRatio.length).toBeGreaterThan(0);
  });

  test("feeds correct elapsed + delta to the active scene each frame", () => {
    const { gl } = makeFakeGL();
    let clock = 1000;
    const renderer = new Renderer(makeCanvas(), { createRenderer: () => gl, now: () => clock });
    const scene = makeScene();
    renderer.setScene(scene);

    renderer.start(); // startTime = lastTime = 1000
    clock = 1016; // ~16ms later
    renderer.frame();
    clock = 1032;
    renderer.frame();

    expect(scene.updates).toHaveLength(2);
    // first frame: elapsed 0.016s, delta 0.016s
    expect(scene.updates[0][0]).toBeCloseTo(0.016, 5);
    expect(scene.updates[0][1]).toBeCloseTo(0.016, 5);
    // second frame: elapsed 0.032s, delta 0.016s
    expect(scene.updates[1][0]).toBeCloseTo(0.032, 5);
    expect(scene.updates[1][1]).toBeCloseTo(0.016, 5);
  });

  test("renders once per frame", () => {
    const { gl, calls } = makeFakeGL();
    const renderer = new Renderer(makeCanvas(), { createRenderer: () => gl, now: () => 0 });
    renderer.setScene(makeScene());
    renderer.start();
    renderer.frame();
    renderer.frame();
    expect(calls.render).toBe(2);
  });

  test("stop() halts the loop so further frames are inert", () => {
    const { gl, calls } = makeFakeGL();
    const renderer = new Renderer(makeCanvas(), { createRenderer: () => gl, now: () => 0 });
    renderer.setScene(makeScene());
    renderer.start();
    const before = calls.render;
    renderer.stop();
    renderer.frame();
    expect(calls.render).toBe(before);
  });

  test("setScene notifies the scene of the current size", () => {
    const { gl } = makeFakeGL();
    const renderer = new Renderer(makeCanvas(1280, 720), { createRenderer: () => gl, now: () => 0 });
    const scene = makeScene();
    renderer.setScene(scene);
    expect(scene.resizes.at(-1)).toEqual([1280, 720]);
  });

  test("handleResize only re-sizes when dimensions change", () => {
    const canvas = makeCanvas(1024, 768);
    const { gl, calls } = makeFakeGL();
    const renderer = new Renderer(canvas, { createRenderer: () => gl, now: () => 0 });
    const sizeCallsAfterCtor = calls.setSize.length;
    renderer.handleResize(); // same dimensions -> no-op
    expect(calls.setSize.length).toBe(sizeCallsAfterCtor);

    (canvas as unknown as { clientWidth: number }).clientWidth = 1600;
    renderer.handleResize();
    expect(calls.setSize.at(-1)).toEqual([1600, 768]);
  });

  test("invokes the onFrame callback once per frame with elapsed + delta", () => {
    const { gl } = makeFakeGL();
    let clock = 1000;
    const frames: Array<[number, number]> = [];
    const renderer = new Renderer(makeCanvas(), {
      createRenderer: () => gl,
      now: () => clock,
      onFrame: (elapsed, delta) => frames.push([elapsed, delta]),
    });
    renderer.setScene(makeScene());

    renderer.start(); // startTime = lastTime = 1000
    clock = 1016;
    renderer.frame();
    clock = 1032;
    renderer.frame();

    expect(frames).toHaveLength(2);
    expect(frames[0][0]).toBeCloseTo(0.016, 5);
    expect(frames[1][0]).toBeCloseTo(0.032, 5);

    // No callback fires once the loop is stopped.
    renderer.stop();
    renderer.frame();
    expect(frames).toHaveLength(2);
  });

  test("dispose() stops the loop and releases scene + GL resources", () => {
    const { gl, calls } = makeFakeGL();
    const renderer = new Renderer(makeCanvas(), { createRenderer: () => gl, now: () => 0 });
    const scene = makeScene();
    renderer.setScene(scene);
    renderer.start();
    renderer.dispose();

    expect(calls.dispose).toBe(1);
    expect(scene.dispose).toHaveBeenCalledTimes(1);

    // Frames after dispose must not render.
    const before = calls.render;
    renderer.frame();
    expect(calls.render).toBe(before);
  });
});
