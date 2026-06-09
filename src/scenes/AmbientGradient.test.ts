import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import {
  AmbientGradient,
  DEFAULT_COLORS,
  DEFAULT_SPEED,
  FRAGMENT_SHADER,
  VERTEX_SHADER,
} from "./AmbientGradient";

describe("AmbientGradient", () => {
  test("exposes the documented uniforms with Aurora defaults", () => {
    const scene = new AmbientGradient();
    const u = scene.material.uniforms;

    expect(u.uTime.value).toBe(0);
    expect(u.uSpeed.value).toBe(DEFAULT_SPEED);
    expect(u.uResolution.value).toBeInstanceOf(THREE.Vector2);
    expect((u.uColorA.value as THREE.Color).getHexString()).toBe(
      new THREE.Color(DEFAULT_COLORS.a).getHexString(),
    );
    expect((u.uColorB.value as THREE.Color).getHexString()).toBe(
      new THREE.Color(DEFAULT_COLORS.b).getHexString(),
    );
    expect((u.uColorC.value as THREE.Color).getHexString()).toBe(
      new THREE.Color(DEFAULT_COLORS.c).getHexString(),
    );
  });

  test("honours custom speed and partial palette overrides", () => {
    const scene = new AmbientGradient({ speed: 0.5, colors: { b: "#00ff00" } });
    const u = scene.material.uniforms;

    expect(u.uSpeed.value).toBe(0.5);
    // overridden color
    expect((u.uColorB.value as THREE.Color).getHexString()).toBe("00ff00");
    // untouched colors keep their defaults
    expect((u.uColorA.value as THREE.Color).getHexString()).toBe(
      new THREE.Color(DEFAULT_COLORS.a).getHexString(),
    );
  });

  test("update() drives only the uTime uniform", () => {
    const scene = new AmbientGradient();
    scene.update(3.5, 0.016);
    expect(scene.material.uniforms.uTime.value).toBe(3.5);
  });

  test("resize() updates the resolution uniform for aspect correction", () => {
    const scene = new AmbientGradient();
    scene.resize(1920, 1080);
    const res = scene.material.uniforms.uResolution.value as THREE.Vector2;
    expect(res.x).toBe(1920);
    expect(res.y).toBe(1080);
  });

  test("setSpeed() retunes the flow at runtime", () => {
    const scene = new AmbientGradient();
    scene.setSpeed(0.42);
    expect(scene.material.uniforms.uSpeed.value).toBe(0.42);
  });

  test("dispose() releases the shader material", () => {
    const scene = new AmbientGradient();
    let disposed = 0;
    scene.material.addEventListener("dispose", () => {
      disposed += 1;
    });
    scene.dispose();
    expect(disposed).toBe(1);
  });

  test("ships a pass-through vertex shader and a single-pass fragment shader", () => {
    // Vertex stage forwards UVs and emits clip-space position directly.
    expect(VERTEX_SHADER).toContain("varying vec2 vUv");
    expect(VERTEX_SHADER).toContain("gl_Position");

    // Fragment stage declares the required uniforms and uses warped FBM noise.
    for (const u of ["uTime", "uSpeed", "uColorA", "uColorB", "uColorC"]) {
      expect(FRAGMENT_SHADER).toContain(u);
    }
    expect(FRAGMENT_SHADER).toContain("fbm");
    expect(FRAGMENT_SHADER).toContain("snoise");
    expect(FRAGMENT_SHADER).toContain("gl_FragColor");
  });
});
