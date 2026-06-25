import * as THREE from "three";
import type { Parameter, ParameterValue } from "../engine/types";
import { hexToColor } from "../engine/palette";
import { FullscreenScene } from "./FullscreenScene";

/**
 * Digital rain (the "Matrix" effect) rendered entirely in a fragment shader:
 * the screen is split into a grid of glyph cells; each column streams downward
 * at its own hashed speed, and a bright leading head fades into a dim tail.
 * Glyphs are procedural cell masks — no font atlas needed — so it stays crisp
 * at any resolution.
 */

export const VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const FRAGMENT_SHADER = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uSpeed;
uniform float uDensity;
uniform float uSize;
uniform vec2  uResolution;
uniform vec3  uColorHead;
uniform vec3  uColorTrail;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// ---- Encoded 5x7 katakana-style bitmap font -------------------------------
// Real glyph shapes, not random dots. Each glyph's 7 rows (5 bits each, MSB =
// leftmost column) are packed into two floats: A holds rows 0-3, B holds rows
// 4-6, base-32. This is the classic "bitmap font in a shader" trick — connected
// strokes read as angular characters, the way Matrix katakana actually look.
vec2 glyphData(float i) {
  if (i < 0.5)  return vec2(462942.0, 8340.0);
  if (i < 1.5)  return vec2(331906.0, 2130.0);
  if (i < 2.5)  return vec2(67556.0,  260.0);
  if (i < 3.5)  return vec2(135327.0, 996.0);
  if (i < 4.5)  return vec2(463844.0, 149.0);
  if (i < 5.5)  return vec2(300996.0, 2097.0);
  if (i < 6.5)  return vec2(1027050.0, 8322.0);
  if (i < 7.5)  return vec2(133182.0, 520.0);
  if (i < 8.5)  return vec2(268228.0, 260.0);
  if (i < 9.5)  return vec2(33855.0,  993.0);
  if (i < 10.5) return vec2(70634.0,  260.0);
  if (i < 11.5) return vec2(81992.0,  465.0);
  if (i < 12.5) return vec2(460863.0, 112.0);
  if (i < 13.5) return vec2(133183.0, 132.0);
  if (i < 14.5) return vec2(135556.0, 452.0);
  if (i < 15.5) return vec2(574794.0, 17.0);
  if (i < 16.5) return vec2(266830.0, 31.0);
  return vec2(47166.0, 386.0);
}

// Decode the lit/unlit bit at (col 0..4, rowTop 0..6) of glyph gi.
float glyphBit(float gi, float col, float rowTop) {
  vec2 d = glyphData(gi);
  float rowVal = rowTop < 3.5
    ? mod(floor(d.x / pow(32.0, rowTop)), 32.0)
    : mod(floor(d.y / pow(32.0, rowTop - 4.0)), 32.0);
  return mod(floor(rowVal / pow(2.0, 4.0 - col)), 2.0);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  // Size drives the glyph footprint: smaller size → many more, finer columns.
  // Base column count is high so the rain reads as fine, delicate katakana
  // rather than chunky blocks; Size scales it and Density only thins the streams.
  float cols = floor(clamp(108.0 / clamp(uSize, 0.35, 2.5), 46.0, 240.0));
  float rows = floor((cols / aspect) * 0.62);

  vec2 grid = vec2(cols, rows);
  vec2 uv = vUv * grid;
  vec2 cellId = floor(uv);
  vec2 cellUv = fract(uv);

  float colSeed = hash(vec2(cellId.x, 7.0));
  float speed = uSpeed * (0.5 + colSeed * 1.5);
  // Falling head position for this column (wraps over rows).
  float head = fract(uTime * 0.15 * speed + colSeed) * rows;
  float dist = head - (rows - cellId.y); // 0 at head, grows down the tail
  float tail = mix(30.0, 8.0, clamp(uDensity, 0.0, 1.0));
  float bright = dist >= 0.0 ? exp(-dist / tail) : 0.0;
  // Some columns rest so the field never looks like a solid wall of glyphs.
  bright *= step(0.12, colSeed) * (0.6 + 0.4 * colSeed);

  // Glyph swaps in discrete frames; flicker + rare bright glint.
  float frame = floor(uTime * 7.0 + hash(cellId) * 12.0);
  float glyphId = floor(hash(cellId + frame * 1.3) * 18.0); // 0..17
  float flick = 0.82 + 0.18 * hash(cellId + frame);
  float glint = step(0.94, hash(cellId + frame * 2.0)) * 0.85;

  // Inner glyph area with margins so adjacent characters stay separated.
  vec2 m = vec2(0.18, 0.07);
  vec2 q = (cellUv - m) / (1.0 - 2.0 * m);
  float gm = 0.0;
  if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
    // Sample the 5x7 bitmap, then render each lit cell as a crisp sub-pixel
    // square with fwidth-based anti-aliasing so the strokes stay fine and sharp
    // at any resolution instead of reading as blocky steps.
    vec2 cell = vec2(q.x * 5.0, (1.0 - q.y) * 7.0);
    float bit = glyphBit(glyphId, floor(cell.x), floor(cell.y));
    vec2 f = fract(cell) - 0.5;
    float d = max(abs(f.x), abs(f.y));
    float aa = fwidth(d) + 0.002;
    gm = bit * smoothstep(0.5, 0.5 - aa - 0.05, d);
  }

  // Leading head reads near-white, fading to the trail color down the stream.
  float headGlow = smoothstep(2.5, 0.0, dist);
  vec3 charCol = mix(uColorTrail, uColorHead, headGlow) + uColorHead * glint;

  vec3 col = charCol * (gm * bright * flick);
  // Faint column haze so bright streams have a subtle luminous bloom.
  col += uColorTrail * bright * 0.04;
  gl_FragColor = vec4(col, 1.0);
}
`;

const DEFAULT_SPEED = 1.0;
const DEFAULT_DENSITY = 0.55;
const DEFAULT_SIZE = 0.85;

export class MatrixRain extends FullscreenScene {
  readonly id = "matrix-rain";
  readonly name = "Matrix Rain";
  readonly description = "Cascading digital glyphs — the iconic green rain.";

  readonly parameters: ReadonlyArray<Parameter> = [
    { kind: "range", id: "speed", label: "Speed", min: 0.2, max: 3.0, step: 0.05, default: DEFAULT_SPEED },
    { kind: "range", id: "density", label: "Density", min: 0.0, max: 1.0, step: 0.01, default: DEFAULT_DENSITY },
    { kind: "range", id: "size", label: "Glyph Size", min: 0.4, max: 2.2, step: 0.05, default: DEFAULT_SIZE },
    { kind: "color", id: "colorHead", label: "Head", default: "#d9ffe0" },
    { kind: "color", id: "colorTrail", label: "Trail", default: "#1bff6b" },
  ];

  protected createMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uSpeed: { value: DEFAULT_SPEED },
        uDensity: { value: DEFAULT_DENSITY },
        uSize: { value: DEFAULT_SIZE },
        uResolution: { value: new THREE.Vector2(1, 1) },
        uColorHead: { value: hexToColor("#d9ffe0") },
        uColorTrail: { value: hexToColor("#1bff6b") },
      },
    });
  }

  setParameter(id: string, value: ParameterValue): void {
    const u = this.material.uniforms;
    switch (id) {
      case "speed":
        u.uSpeed.value = Number(value);
        break;
      case "density":
        u.uDensity.value = Number(value);
        break;
      case "size":
        u.uSize.value = Number(value);
        break;
      case "colorHead":
        (u.uColorHead.value as THREE.Color).set(String(value));
        break;
      case "colorTrail":
        (u.uColorTrail.value as THREE.Color).set(String(value));
        break;
    }
  }
}
