import { describe, expect, it } from "bun:test";
import { hexToVec3, PALETTE_OPTIONS, PALETTES, paletteById } from "./palette";

describe("palette", () => {
  it("paletteById returns the matching palette", () => {
    expect(paletteById("ocean").id).toBe("ocean");
  });

  it("paletteById falls back to the first palette for unknown ids", () => {
    expect(paletteById("does-not-exist").id).toBe(PALETTES[0].id);
  });

  it("PALETTE_OPTIONS mirrors PALETTES one-to-one", () => {
    expect(PALETTE_OPTIONS.map((o) => o.value)).toEqual(PALETTES.map((p) => p.id));
  });

  it("hexToVec3 yields components in [0,1]", () => {
    const v = hexToVec3("#ffffff");
    expect(v.x).toBeCloseTo(1);
    expect(v.y).toBeCloseTo(1);
    expect(v.z).toBeCloseTo(1);
  });
});
