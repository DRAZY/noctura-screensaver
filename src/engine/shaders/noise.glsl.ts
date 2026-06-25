/**
 * Reusable GLSL noise snippets, exported as strings so scenes can compose them
 * into their shaders instead of copy-pasting. Kept in one place so a fix to the
 * noise benefits every scene.
 *
 * Sources: Ashima Arts / Stefan Gustavson simplex noise (MIT). The 2D and 3D
 * variants are texture-free and GPU-friendly. `fbm2` stacks octaves; `curlNoise`
 * derives a divergence-free flow field from 3D simplex for particle advection.
 */

/** 2D simplex noise → `float snoise(vec2)` in ~[-1,1]. */
export const SIMPLEX_2D = /* glsl */ `
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289_2(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute3(vec3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289_2(i);
  vec3 p = permute3(permute3(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

/** 2D fractional Brownian motion (5 octaves). Requires {@link SIMPLEX_2D}. */
export const FBM_2D = /* glsl */ `
float fbm2(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  float freq = 1.0;
  for (int i = 0; i < 5; i++) {
    sum += amp * snoise(p * freq);
    freq *= 2.0;
    amp *= 0.5;
  }
  return sum;
}
`;

/** 3D simplex noise → `float snoise3(vec3)` in ~[-1,1]. Standalone. */
export const SIMPLEX_3D = /* glsl */ `
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289_3b(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute4(vec4 x) { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt4(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise3(vec3 v) {
  const vec2 C = vec2(1.0/6.0, 1.0/3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289_3b(i);
  vec4 p = permute4(permute4(permute4(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt4(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

/**
 * Triangular-PDF ordered dither → `vec3 dither(vec2 fragCoord)`, ~±1 LSB at
 * 8-bit. Add to the final color before output to break up the visible stair-step
 * banding that smooth/dark gradients otherwise show on 8-bit displays. Standalone
 * (no other snippet needed). Cost is a few cheap hashes per pixel.
 */
export const DITHER = /* glsl */ `
float ditherHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 dither(vec2 fragCoord) {
  // Two uniform hashes combined → triangular distribution (cleaner than uniform).
  vec3 u1 = vec3(ditherHash(fragCoord), ditherHash(fragCoord + 11.7), ditherHash(fragCoord + 23.3));
  vec3 u2 = vec3(ditherHash(fragCoord + 41.1), ditherHash(fragCoord + 57.9), ditherHash(fragCoord + 71.3));
  return (u1 + u2 - 1.0) / 255.0;
}
`;

/** Divergence-free curl noise → `vec3 curlNoise(vec3)`. Requires {@link SIMPLEX_3D}. */
export const CURL_NOISE = /* glsl */ `
vec3 curlNoise(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);

  // Build a pseudo vector-potential by sampling the scalar field on three
  // decorrelated lattices, then take its curl via central differences.
  vec3 p_x0 = vec3(snoise3(p - dx), snoise3(p - dx + vec3(31.4)), snoise3(p - dx + vec3(57.7)));
  vec3 p_x1 = vec3(snoise3(p + dx), snoise3(p + dx + vec3(31.4)), snoise3(p + dx + vec3(57.7)));
  vec3 p_y0 = vec3(snoise3(p - dy), snoise3(p - dy + vec3(31.4)), snoise3(p - dy + vec3(57.7)));
  vec3 p_y1 = vec3(snoise3(p + dy), snoise3(p + dy + vec3(31.4)), snoise3(p + dy + vec3(57.7)));
  vec3 p_z0 = vec3(snoise3(p - dz), snoise3(p - dz + vec3(31.4)), snoise3(p - dz + vec3(57.7)));
  vec3 p_z1 = vec3(snoise3(p + dz), snoise3(p + dz + vec3(31.4)), snoise3(p + dz + vec3(57.7)));

  float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
  float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
  float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);
  return normalize(vec3(x, y, z) / (2.0 * e) + 1e-6);
}
`;
