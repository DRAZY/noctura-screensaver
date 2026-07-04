import { describe, expect, it } from "bun:test";
import * as THREE from "three";
import { AmbientGradient, DEFAULT_SPEED, FRAGMENT_SHADER } from "./AmbientGradient";
import { defaultsFor } from "../engine/types";
import { NATIVE_DEFAULTS, remapSpeed } from "../engine/sceneParams";

/** Cast helper to read the protected ShaderMaterial in tests. */
function uniforms(scene: AmbientGradient) {
  return (scene as unknown as { material: THREE.ShaderMaterial }).material.uniforms;
}

describe("AmbientGradient (Scene)", () => {
  it("exposes stable scene metadata", () => {
    const s = new AmbientGradient();
    expect(s.id).toBe("ambient-gradient");
    expect(s.name.length).toBeGreaterThan(0);
    expect(s.parameters.length).toBeGreaterThan(0);
  });

  it("declares the shared native Speed control (default = native)", () => {
    const s = new AmbientGradient();
    const speed = s.parameters.find((p) => p.id === "speed");
    expect(speed?.kind).toBe("range");
    // Parity: every scene's Speed defaults to the native global default, not the
    // scene's own internal tuning constant.
    expect(defaultsFor(s).speed).toBe(NATIVE_DEFAULTS.speed);
  });

  it("builds a material on init with the expected uniforms", () => {
    const s = new AmbientGradient();
    s.init({ renderer: {} as THREE.WebGLRenderer, width: 100, height: 100 });
    const u = uniforms(s);
    expect(u.uTime.value).toBe(0);
    expect(u.uSpeed.value).toBe(DEFAULT_SPEED);
  });

  it("setParameter('speed') updates uSpeed via the native proportional remap", () => {
    const s = new AmbientGradient();
    s.init({ renderer: {} as THREE.WebGLRenderer, width: 1, height: 1 });
    s.setParameter("speed", 0.42);
    // The native Speed knob is remapped onto the scene's uniform, anchored on the
    // scene's own default so its tuned look is preserved at the native default.
    expect(uniforms(s).uSpeed.value).toBeCloseTo(remapSpeed(0.42, DEFAULT_SPEED));
  });

  it("setParameter('theme') swaps all three palette colors", () => {
    const s = new AmbientGradient();
    s.init({ renderer: {} as THREE.WebGLRenderer, width: 1, height: 1 });
    s.setParameter("theme", "ocean");
    const u = uniforms(s);
    // Ocean palette a = #030e2e
    expect((u.uColorA.value as THREE.Color).getHexString()).toBe(
      new THREE.Color("#030e2e").getHexString(),
    );
  });

  it("update advances uTime; resize sets uResolution", () => {
    const s = new AmbientGradient();
    s.init({ renderer: {} as THREE.WebGLRenderer, width: 1, height: 1 });
    s.update(3.5, 0.016);
    expect(uniforms(s).uTime.value).toBeCloseTo(3.5);
    s.resize(1920, 1080);
    const res = uniforms(s).uResolution.value as THREE.Vector2;
    expect([res.x, res.y]).toEqual([1920, 1080]);
  });

  it("fragment shader includes the shared noise + fbm symbols", () => {
    expect(FRAGMENT_SHADER).toContain("snoise");
    expect(FRAGMENT_SHADER).toContain("fbm2");
  });
});
