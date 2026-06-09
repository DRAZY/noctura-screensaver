import { describe, expect, test } from "bun:test";
import { computeFps } from "./fps";

describe("computeFps", () => {
  test("computes a steady 60fps over a one-second window", () => {
    expect(computeFps(60, 1)).toBe(60);
  });

  test("scales for sub-second sampling windows", () => {
    expect(computeFps(30, 0.5)).toBe(60);
  });

  test("rounds to the nearest whole frame", () => {
    expect(computeFps(59, 1.01)).toBe(58); // 58.41 -> 58
  });

  test("returns 0 for a non-positive or non-finite window", () => {
    expect(computeFps(60, 0)).toBe(0);
    expect(computeFps(60, -1)).toBe(0);
    expect(computeFps(60, Infinity)).toBe(0);
    expect(computeFps(60, NaN)).toBe(0);
  });
});
