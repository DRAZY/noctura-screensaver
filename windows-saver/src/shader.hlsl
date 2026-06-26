// Noctura — Direct3D 11 (HLSL) port of the canonical multi-scene shader.
//
// Faithful translation of native-saver/Sources/AuroraShader.swift (Metal MSL).
// Same 13 scenes, same uniform layout (112-byte constant buffer), same dither.
// Compiled at runtime via D3DCompile (d3dcompiler_47.dll ships with Windows),
// mirroring the macOS saver's runtime MSL compilation.
//
// Scene dispatch order (u.scene): 0 Aurora Drift · 1 Northern Lights ·
// 2 Deep Space · 3 Particle Drift · 4 Plasma Field · 5 Matrix Rain ·
// 6 Fireflies · 7 Black Hole · 8 Hyperspace Tunnel · 9 Synthwave ·
// 10 Kaleidoscope · 11 Caustics · 12 Polar Clock.

cbuffer Constants : register(b0)
{
    float  uTime;
    float  uSpeed;
    float  uIntensity;
    float  uDensity;
    float  uScene;
    float  uMonth;
    float  uTicks;
    float  uSize;
    float2 uResolution;
    float2 uPad1;
    float4 uColorA;
    float4 uColorB;
    float4 uColorC;
    float4 uClock;   // sec, min, hour, day
};

struct VSOut {
    float4 pos : SV_Position;
    float2 uv  : TEXCOORD0;
};

VSOut VSMain(uint vid : SV_VertexID)
{
    float2 verts[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    VSOut o;
    float2 p = verts[vid];
    o.pos = float4(p, 0.0, 1.0);
    o.uv  = p * 0.5 + 0.5;
    return o;
}

// ---- 2D simplex noise ------------------------------------------------------
float3 mod289_3(float3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
float2 mod289_2(float2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
float3 permute3(float3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }

float snoise(float2 v) {
    const float4 C = float4(0.211324865405187, 0.366025403784439,
                           -0.577350269189626, 0.024390243902439);
    float2 i  = floor(v + dot(v, C.yy));
    float2 x0 = v - i + dot(i, C.xx);
    float2 i1 = (x0.x > x0.y) ? float2(1.0, 0.0) : float2(0.0, 1.0);
    float4 x12 = x0.xyxy + C.xxzz;
    x12.xy -= i1;
    i = mod289_2(i);
    float3 p = permute3(permute3(i.y + float3(0.0, i1.y, 1.0)) + i.x + float3(0.0, i1.x, 1.0));
    float3 m = max(0.5 - float3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
    m = m*m; m = m*m;
    float3 x = 2.0 * frac(p * C.www) - 1.0;
    float3 h = abs(x) - 0.5;
    float3 ox = floor(x + 0.5);
    float3 a0 = x - ox;
    m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
    float3 g;
    g.x  = a0.x  * x0.x  + h.x  * x0.y;
    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
    return 130.0 * dot(m, g);
}

float fbm2(float2 p) {
    float sum = 0.0, amp = 0.5, freq = 1.0;
    for (int i = 0; i < 5; i++) { sum += amp * snoise(p * freq); freq *= 2.0; amp *= 0.5; }
    return sum;
}

float hash21(float2 p) {
    p = frac(p * float2(123.34, 345.45));
    p += dot(p, p + 34.345);
    return frac(p.x * p.y);
}

// ---- Dither: triangular-PDF ~±1 LSB to kill 8-bit gradient banding ---------
float ditherHash(float2 p) {
    float3 p3 = frac(float3(p.x, p.y, p.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return frac((p3.x + p3.y) * p3.z);
}
float3 ditherRGB(float2 fc) {
    float3 u1 = float3(ditherHash(fc), ditherHash(fc + 11.7), ditherHash(fc + 23.3));
    float3 u2 = float3(ditherHash(fc + 41.1), ditherHash(fc + 57.9), ditherHash(fc + 71.3));
    return (u1 + u2 - 1.0) / 255.0;
}

// Explicit 2x2 rotations (avoids HLSL/MSL matrix-convention ambiguity).
// mul_mm2 reproduces MSL `p * mm2(a)` where mm2(a)=float2x2(c,s,-s,c).
float2 mul_mm2(float2 p, float a) { float c = cos(a), s = sin(a); return float2(p.x*c + p.y*s, -p.x*s + p.y*c); }
// mul_krot reproduces MSL `kRot(a) * p` where kRot(a)=float2x2(c,-s,s,c).
float2 mul_krot(float a, float2 p) { float c = cos(a), s = sin(a); return float2(c*p.x + s*p.y, -s*p.x + c*p.y); }

// ---- Scene 0: Aurora Drift -------------------------------------------------
float3 sceneAurora(float2 uv, float aspect) {
    float2 p = float2((uv.x - 0.5) * aspect, uv.y - 0.5) * 1.15;
    float t = uTime * uSpeed;
    float2 q = float2(fbm2(p + 0.15*t), fbm2(p + float2(5.2,1.3) - 0.12*t));
    float2 r = float2(fbm2(p + 1.8*q + float2(1.7,9.2) + 0.10*t),
                      fbm2(p + 1.8*q + float2(8.3,2.8) - 0.08*t));
    float f = fbm2(p + 2.2*r);
    float m = clamp(f*0.5 + 0.5, 0.0, 1.0);
    float3 col = lerp(uColorA.rgb, uColorB.rgb, smoothstep(0.0, 0.55, m));
    col = lerp(col, uColorC.rgb, smoothstep(0.45, 1.0, m));
    col += 0.06 * length(r) * uIntensity;
    return col;
}

// ---- Scene 1: Northern Lights ----------------------------------------------
float tri(float x) { return clamp(abs(frac(x) - 0.5), 0.01, 0.49); }
float2 tri2(float2 p) { return float2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x))); }
float triNoise2d(float2 p, float spd, float t) {
    float z = 1.8, z2 = 2.5, rz = 0.0;
    p = mul_mm2(p, p.x * 0.06);
    float2 bp = p;
    for (float i = 0.0; i < 5.0; i++) {
        float2 dg = tri2(bp * 1.85) * 0.75;
        dg = mul_mm2(dg, t * spd);
        p -= dg / z2;
        bp *= 1.3; z2 *= 0.45; z *= 0.42;
        p *= 1.21 + (rz - 1.0) * 0.02;
        rz += tri(p.x + tri(p.y)) * z;
        p = -mul_mm2(p, 2.0);
    }
    return clamp(1.0 / pow(rz * 29.0, 1.3), 0.0, 0.55);
}
float3 sceneRibbons(float2 uv0, float aspect) {
    float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y);
    float t = uTime * uSpeed;
    float3 col = lerp(uColorA.rgb, uColorA.rgb * 1.9, uv0.y);
    int layers = 4;
    float3 aur = float3(0.0, 0.0, 0.0);
    for (int i = 0; i < 5; i++) {
        if (i >= layers) break;
        float fl = float(i);
        float sway = 0.35 * sin(uv0.y * 2.0 + t * 0.3 + fl * 1.7);
        float2 ap = float2(uv.x * (1.25 + fl * 0.45) + sway + fl * 4.0,
                           uv0.y * 0.7 - t * (0.05 + fl * 0.03));
        float n = triNoise2d(ap, 0.05 + fl * 0.015, t);
        float vEnv = smoothstep(0.0, 0.28, uv0.y) * smoothstep(1.15, 0.45, uv0.y);
        float inten = n * vEnv;
        float3 lcol = lerp(uColorB.rgb, uColorC.rgb, clamp(uv0.y * 1.05, 0.0, 1.0));
        lcol = lerp(lcol, float3(0.72, 0.28, 0.96), smoothstep(0.6, 1.05, uv0.y) * 0.5);
        aur += lcol * inten * (1.5 - fl * 0.22);
    }
    col += aur * (1.1 * uIntensity);
    col += uColorB.rgb * smoothstep(0.22, 0.0, uv0.y) * 0.12;
    col = col / (col + 0.7);
    return pow(col, float3(0.85, 0.85, 0.85));
}

// ---- Scene 2: Deep Space ---------------------------------------------------
float3 starLayer(float2 uv, float scale, float drift, float threshold, float3 tint, float time, float size) {
    uv = uv * scale + float2(drift, drift * 0.3);
    float2 cell = floor(uv);
    float2 f = frac(uv) - 0.5;
    float h = hash21(cell);
    float present = step(threshold, h);
    float2 starPos = (float2(hash21(cell + 1.7), hash21(cell + 4.1)) - 0.5) * 0.7;
    float d = length(f - starPos);
    float core = smoothstep(size, 0.0, d);
    float halo = smoothstep(size * 3.5, 0.0, d) * 0.35;
    float tw = 0.6 + 0.4 * sin(time * (1.5 + 3.0*h) + h*30.0);
    return tint * present * (core + halo) * tw;
}
float3 sceneDeepSpace(float2 uv0, float aspect) {
    float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float t = uTime * uSpeed;
    float nebAmt = uIntensity;
    float2 np = uv * 1.3 + float2(0.04*t, -0.02*t);
    float n = fbm2(np + fbm2(np * 1.7 + t * 0.05));
    float neb = smoothstep(-0.2, 0.85, n);
    float3 col = lerp(uColorA.rgb, uColorB.rgb, neb * nebAmt);
    col += uColorB.rgb * pow(max(n, 0.0), 3.0) * nebAmt * 0.9;
    float n2 = fbm2(np * 0.8 + float2(5.2, 1.7) - t * 0.03);
    col += uColorC.rgb * smoothstep(0.45, 1.0, n2) * nebAmt * 0.2;
    float thr = lerp(0.985, 0.93, clamp(uDensity, 0.0, 1.0));
    col += starLayer(uv, 14.0, t*0.20, thr,        uColorC.rgb,       uTime, 0.05) * 1.0;
    col += starLayer(uv,  9.0, t*0.12, thr+0.005,  uColorC.rgb*0.9,   uTime, 0.06) * 0.8;
    col += starLayer(uv,  5.0, t*0.06, thr+0.008,  uColorC.rgb*0.8,   uTime, 0.07) * 0.6;
    col += starLayer(uv,  3.0, t*0.03, thr+0.02,   uColorC.rgb*1.4,   uTime, 0.10) * 1.5;
    return col;
}

// ---- Scene 3: Particle Drift -----------------------------------------------
// Luminous points streaming through a curl-noise flow field, matching the
// gallery app's FlowingParticles look: soft additive core+halo sprites tinted
// base->accent by flow speed, over a near-black field, with a slow drift spin.
float3 sceneParticles(float2 uv0, float aspect) {
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * 2.2;
    float t = uTime * uSpeed;
    // Slow rotation, mirroring the app's points.rotation.y = time * 0.03.
    float ca = cos(t * 0.03), sa = sin(t * 0.03);
    p = float2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
    float3 col = uColorA.rgb * 0.05;
    float thr = lerp(0.92, 0.55, clamp(uDensity, 0.0, 1.0));
    for (int L = 0; L < 4; L++) {
        float fl = float(L);
        float scale = 5.0 + fl * 4.0;
        float2 fp = p * 0.7 + fl * 3.1;
        float2 flow = float2(fbm2(fp + float2(0.0, t * 0.15)),
                             fbm2(fp + float2(5.2, 1.3) - t * 0.12));
        float flowLen = length(flow);
        float2 g = p * scale + flow * 1.8;
        float2 cell = floor(g);
        float2 f = frac(g) - 0.5;
        float h = hash21(cell + fl * 17.0);
        float present = step(thr, h);
        float2 pp = (float2(hash21(cell + 2.3), hash21(cell + 8.1)) - 0.5) * 0.7;
        float d = length(f - pp);
        // Bright core + soft halo → luminous additive bloom (matches app FRAG).
        float core = smoothstep(0.16, 0.0, d);
        float halo = smoothstep(0.42, 0.0, d) * 0.35;
        float glow = present * (1.6 * core + 0.5 * halo) * (0.5 + 0.5 * h);
        float3 tint = lerp(uColorB.rgb, uColorC.rgb, clamp(flowLen * 0.9, 0.0, 1.0));
        col += tint * glow * (1.3 * uIntensity) * (1.0 - fl * 0.12);
    }
    return col;
}

// ---- Scene 12: Polar Clock -------------------------------------------------
float3 scenePolar(float2 uv0, float aspect) {
    const float TAU = 6.28318530718;
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float r = length(p);
    float ang = atan2(p.x, p.y);
    float fracv = frac(ang / TAU);
    float aaR = fwidth(r);
    float aaA = min(fwidth(fracv), 0.02);
    float3 col = uColorA.rgb;
    float ht = 0.03 * 0.5;
    float fracs[5] = { uClock.x, uClock.y, uClock.z, uClock.w, uMonth };
    for (int i = 0; i < 5; i++) {
        float radius = 0.40 - float(i) * 0.072;
        float ring = smoothstep(ht + aaR, ht - aaR, abs(r - radius));
        float3 tint = lerp(uColorC.rgb, uColorB.rgb, float(i) / 6.0);
        col = lerp(col, uColorB.rgb * 0.7, ring * 0.35);
        float v = fracs[i];
        float arc = smoothstep(v + aaA, v - aaA, fracv);
        col = lerp(col, tint, ring * arc);
        col += tint * ring * arc * 0.22;
        float ha = v * TAU;
        float2 hp = float2(sin(ha), cos(ha)) * radius;
        float cap = smoothstep(ht * 1.5 + aaR, ht * 1.5 - aaR, length(p - hp));
        col += lerp(tint, uColorC.rgb, 0.5) * cap * smoothstep(0.0, 0.02, v) * 0.9;
    }
    if (uTicks > 0.5) {
        float tp = abs(frac(fracv * 12.0) - 0.5) * 2.0;
        float aaT = fwidth(tp);
        float tick = smoothstep(0.85 - aaT, 0.85 + aaT, tp);
        float tickRing = smoothstep(ht * 0.9 + aaR, ht * 0.9 - aaR, abs(r - 0.45));
        col = lerp(col, uColorC.rgb, tick * tickRing * 0.7);
    }
    return col;
}

// ---- Scene 4: Plasma Field -------------------------------------------------
float3 plasmaCyc(float x, float3 A, float3 B, float3 C) {
    float f = frac(x);
    if (f < 0.3333) return lerp(A, B, f / 0.3333);
    if (f < 0.6666) return lerp(B, C, (f - 0.3333) / 0.3333);
    return lerp(C, A, (f - 0.6666) / 0.3334);
}
float3 scenePlasma(float2 uv, float aspect) {
    float2 p = float2((uv.x - 0.5) * aspect, uv.y - 0.5) * 6.0;
    float t = uTime * uSpeed;
    float2 w = p + float2(sin(t * 0.3 + p.y * 0.5), cos(t * 0.27 + p.x * 0.5)) * 1.2;
    float v = 0.0;
    v += sin(w.x * 1.2 + t);
    v += sin(w.y * 1.5 - t * 1.1);
    v += sin((w.x + w.y) * 0.9 + t * 0.7);
    v += sin((w.x - w.y) * 1.3 - t * 0.5);
    float2 c = p - float2(sin(t * 0.4), cos(t * 0.5)) * 2.5;
    v += 1.4 * sin(length(c) * 1.4 - t * 1.3);
    v *= 0.32;
    float3 col = plasmaCyc(v + t * 0.15, uColorA.rgb, uColorB.rgb, uColorC.rgb);
    float crest = pow(abs(sin(v * 3.14159 * 2.0)), 10.0);
    col += uColorC.rgb * crest * 0.6;
    float vig = 1.0 - 0.3 * dot(uv - 0.5, uv - 0.5);
    return col * vig;
}

// ---- Scene 5: Matrix Rain --------------------------------------------------
float2 mGlyphData(float i) {
    if (i < 0.5)  return float2(462942.0, 8340.0);
    if (i < 1.5)  return float2(331906.0, 2130.0);
    if (i < 2.5)  return float2(67556.0,  260.0);
    if (i < 3.5)  return float2(135327.0, 996.0);
    if (i < 4.5)  return float2(463844.0, 149.0);
    if (i < 5.5)  return float2(300996.0, 2097.0);
    if (i < 6.5)  return float2(1027050.0, 8322.0);
    if (i < 7.5)  return float2(133182.0, 520.0);
    if (i < 8.5)  return float2(268228.0, 260.0);
    if (i < 9.5)  return float2(33855.0,  993.0);
    if (i < 10.5) return float2(70634.0,  260.0);
    if (i < 11.5) return float2(81992.0,  465.0);
    if (i < 12.5) return float2(460863.0, 112.0);
    if (i < 13.5) return float2(133183.0, 132.0);
    if (i < 14.5) return float2(135556.0, 452.0);
    if (i < 15.5) return float2(574794.0, 17.0);
    if (i < 16.5) return float2(266830.0, 31.0);
    return float2(47166.0, 386.0);
}
float mGlyphBit(float gi, float col, float rowTop) {
    float2 d = mGlyphData(gi);
    float rowVal = rowTop < 3.5
        ? fmod(floor(d.x / pow(32.0, rowTop)), 32.0)
        : fmod(floor(d.y / pow(32.0, rowTop - 4.0)), 32.0);
    return fmod(floor(rowVal / pow(2.0, 4.0 - col)), 2.0);
}
float3 sceneMatrix(float2 uv0, float aspect) {
    float density = clamp(uDensity, 0.0, 1.0);
    float cols = floor(clamp(108.0 / clamp(uSize, 0.35, 2.5), 46.0, 240.0));
    float rows = floor((cols / aspect) * 0.62);
    float2 grid = float2(cols, rows);
    float2 uv = uv0 * grid;
    float2 cellId = floor(uv);
    float2 cellUv = frac(uv);
    float colSeed = hash21(float2(cellId.x, 7.0));
    float spd = uSpeed * (0.5 + colSeed * 1.5);
    float head = frac(uTime * 0.15 * spd + colSeed) * rows;
    float dist = head - (rows - cellId.y);
    float tail = lerp(30.0, 8.0, density);
    float bright = (dist >= 0.0) ? exp(-dist / tail) : 0.0;
    bright *= step(0.12, colSeed) * (0.6 + 0.4 * colSeed);
    float frame = floor(uTime * 7.0 + hash21(cellId) * 12.0);
    float glyphId = floor(hash21(cellId + frame * 1.3) * 18.0);
    float flick = 0.82 + 0.18 * hash21(cellId + frame);
    float glint = step(0.94, hash21(cellId + frame * 2.0)) * 0.85;
    float2 m = float2(0.18, 0.07);
    float2 q = (cellUv - m) / (1.0 - 2.0 * m);
    float gm = 0.0;
    if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
        float2 cell = float2(q.x * 5.0, (1.0 - q.y) * 7.0);
        float bit = mGlyphBit(glyphId, floor(cell.x), floor(cell.y));
        float2 f = frac(cell) - 0.5;
        float d = max(abs(f.x), abs(f.y));
        float aa = fwidth(d) + 0.002;
        gm = bit * smoothstep(0.5, 0.5 - aa - 0.05, d);
    }
    float headGlow = smoothstep(2.5, 0.0, dist);
    float3 charCol = lerp(uColorB.rgb, uColorC.rgb, headGlow) + uColorC.rgb * glint;
    float3 col = charCol * (gm * bright * flick) * uIntensity;
    col += uColorB.rgb * bright * 0.04;
    return col;
}

// ---- Scene 6: Fireflies ----------------------------------------------------
float3 sceneFireflies(float2 uv0, float aspect) {
    float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float3 col = lerp(uColorA.rgb * 0.3, uColorA.rgb, uv0.y);
    float t = uTime * uSpeed;
    int count = int(lerp(14.0, 48.0, clamp(uDensity, 0.0, 1.0)));
    float glow = max(uIntensity, 0.3);
    float sz = clamp(uSize, 0.3, 3.0);
    for (int i = 0; i < 48; i++) {
        if (i >= count) break;
        float fi = float(i);
        float2 home = (float2(hash21(float2(fi, 1.0)), hash21(float2(fi, 7.0))) - 0.5) * 2.0;
        float2 drift = float2(sin(t * 0.3 + fi * 1.7), sin(t * 0.27 + fi * 2.39 + 1.5707963));
        float2 pos = (home * 0.8 + drift * 0.22) * float2(aspect, 1.0) * 0.55;
        float pulse = 0.5 + 0.5 * sin(t * 2.0 + fi * 2.39);
        float d = length(uv - pos);
        float core = glow * (0.0009 * sz) / (d * d + 0.0006 * sz);
        col += uColorC.rgb * core * (0.35 + 0.65 * pulse);
    }
    return col;
}

// ---- Scene 7: Black Hole ---------------------------------------------------
float3 sceneBlackHole(float2 uv0, float aspect) {
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float r = length(p);
    float a = atan2(p.y, p.x);
    float t = uTime * uSpeed;
    float size = 1.6;
    float horizon = 0.13 * size;
    float ringR = 0.165 * size;
    float swirl = a + t * (0.6 / max(r, 0.05));
    float2 swdir = float2(cos(swirl), sin(swirl)) * 1.6;
    float disk = fbm2(swdir + float2(r * 6.0 - t * 0.5, 0.0));
    disk = pow(clamp(disk * 0.5 + 0.5, 0.0, 1.0), 1.5);
    float band = smoothstep(horizon, ringR * 1.4, r) * (1.0 - smoothstep(0.5 * size, 1.1 * size, r));
    float3 diskCol = lerp(uColorB.rgb, uColorC.rgb, disk) * disk * band * 2.2;
    float ring = exp(-pow((r - ringR) * 26.0, 2.0));
    diskCol += uColorC.rgb * ring * 1.6;
    float hole = smoothstep(horizon * 0.75, horizon, r);
    float3 col = diskCol * hole;
    float lens = 1.0 - exp(-r * 3.0);
    float stars = step(0.997, snoise(p * 90.0 * lens));
    col += float3(stars, stars, stars) * 0.5 * hole;
    return col;
}

// ---- Scene 8: Hyperspace Tunnel --------------------------------------------
float3 sceneTunnel(float2 uv0, float aspect) {
    const float TAU = 6.28318530718;
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float r = length(p);
    float a = atan2(p.y, p.x);
    float t = uTime * uSpeed;
    float depth = 0.35 / max(r, 0.04) + t * 2.0;
    float spin = a + depth * 0.22;
    float2 wdir = float2(cos(spin), sin(spin)) * 1.8;
    float wall = fbm2(wdir + float2(depth * 1.2, 0.0));
    float rings = 0.5 + 0.5 * sin(depth * TAU);
    float pat = lerp(wall, rings, 0.4);
    float3 col = lerp(uColorA.rgb, uColorB.rgb, pat);
    col = lerp(col, uColorC.rgb, smoothstep(0.5, 0.95, wall));
    float streak = pow(0.5 + 0.5 * sin(spin * 16.0 + t * 0.6), 6.0);
    streak *= 0.5 + 0.5 * sin(depth * 3.0);
    col += uColorC.rgb * streak * smoothstep(0.12, 0.7, r) * 0.7;
    col *= smoothstep(0.03, 0.5, r);
    col *= 1.3;
    col += uColorC.rgb * smoothstep(0.18, 0.0, r) * 1.9;
    return col;
}

// ---- Scene 9: Synthwave ----------------------------------------------------
float synthGridLine(float coord) {
    float w = fwidth(coord) * 1.5 + 0.02;
    float f = abs(frac(coord) - 0.5);
    return smoothstep(0.5 - w, 0.5, f);
}
float3 sceneSynthwave(float2 uv, float aspect) {
    float t = uTime * uSpeed;
    const float HORIZON = 0.5;
    float3 col;
    if (uv.y > HORIZON) {
        float sky = (uv.y - HORIZON) / (1.0 - HORIZON);
        col = lerp(uColorB.rgb * 0.55, uColorA.rgb, pow(sky, 0.8));
        float2 sc = float2((uv.x - 0.5) * aspect, uv.y - 0.63);
        float sd = length(sc);
        float sunR = 0.17;
        float3 sunCol = lerp(uColorB.rgb, lerp(uColorB.rgb, float3(1.0, 0.95, 0.7), 0.6), clamp((0.63 - uv.y) / 0.34 + 0.5, 0.0, 1.0));
        float stripe = smoothstep(0.35, 0.65, frac((0.63 - uv.y) * 26.0));
        float gapMask = lerp(1.0, stripe, smoothstep(0.63, 0.5, uv.y));
        float disc = smoothstep(sunR, sunR - 0.006, sd) * gapMask;
        col = lerp(col, sunCol, disc);
        col += uColorB.rgb * smoothstep(sunR * 2.6, 0.0, sd) * 0.45;
    } else {
        col = uColorA.rgb * 0.12;
        float zy = HORIZON - uv.y;
        float persp = 0.10 / (zy + 0.0025);
        float gx = (uv.x - 0.5) * aspect * persp * 3.5;
        float gz = persp * 5.0 - t * 2.0;
        float gridLines = max(synthGridLine(gx), synthGridLine(gz));
        float fade = smoothstep(0.0, 0.16, zy);
        col += uColorC.rgb * gridLines * fade * 1.3;
        col += uColorB.rgb * smoothstep(0.16, 0.0, abs(uv.x - 0.5) * aspect) * smoothstep(0.0, 0.4, zy) * 0.15;
    }
    col += uColorB.rgb * smoothstep(0.03, 0.0, abs(uv.y - HORIZON)) * 1.4;
    return col;
}

// ---- Scene 10: Kaleidoscope ------------------------------------------------
float3 kCyc(float x, float3 A, float3 B, float3 C) {
    float f = frac(x);
    if (f < 0.3333) return lerp(A, B, f / 0.3333);
    if (f < 0.6666) return lerp(B, C, (f - 0.3333) / 0.3333);
    return lerp(C, A, (f - 0.6666) / 0.3334);
}
float3 sceneKaleidoscope(float2 uv0, float aspect) {
    const float TAU = 6.28318530718;
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float t = uTime * uSpeed;
    p = mul_krot(t * 0.1, p);
    float r = length(p);
    float a = atan2(p.y, p.x);
    float seg = TAU / 8.0;
    a = abs(fmod(a, seg) - seg * 0.5);
    float zoom = 2.0 + 0.35 * sin(t * 0.2);
    float2 q = float2(cos(a), sin(a)) * r * zoom;
    float detail = smoothstep(0.03, 0.28, r);
    float n = fbm2(q * 1.15 + float2(t * 0.15, -t * 0.1));
    float phase = r * 11.0 - t * 1.4 + n * 2.5;
    float bands = 0.5 + 0.5 * sin(phase);
    float bw = max(fwidth(phase), 0.001);
    float petal = smoothstep(0.62 - bw, 0.62 + bw, bands);
    float v = n * 1.2 * detail + bands * 0.35;
    float3 col = kCyc(v + t * 0.08, uColorA.rgb, uColorB.rgb, uColorC.rgb);
    col += uColorC.rgb * petal * 0.5 * detail;
    col *= 0.55 + 0.55 * smoothstep(1.4, 0.0, r);
    return col;
}

// ---- Scene 11: Caustics ----------------------------------------------------
float2 cCellPoint(float2 cell) {
    float h = dot(cell, float2(127.1, 311.7));
    float2 r = float2(sin(h) * 43758.5453, sin(h + 1.0) * 22578.1459);
    return frac(r);
}
float2 cWorley(float2 p, float t) {
    float2 base = floor(p);
    float2 f = frac(p);
    float f1 = 8.0;
    float f2 = 8.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            float2 cell = base + float2(float(i), float(j));
            float2 fp = cCellPoint(cell);
            fp = 0.5 + 0.5 * sin(t + 6.2831853 * fp);
            float2 diff = float2(float(i), float(j)) + fp - f;
            float d = length(diff);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
        }
    }
    return float2(f1, f2);
}
float cCausticLayer(float2 p, float t, float sharp) {
    float2 w = cWorley(p, t);
    float border = w.y - w.x;
    float aa = fwidth(border) + 1e-4;
    float edge = 1.0 - smoothstep(0.0, 0.07 + aa, border);
    return pow(clamp(edge, 0.0, 1.0), sharp);
}
float3 sceneCaustics(float2 uv0, float aspect) {
    float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float t = uTime * uSpeed;
    float scale = 5.0;
    float2 p = uv * scale / max(uSize, 0.0001);
    float warpT = t * 0.35;
    float2 warp = float2(fbm2(p * 0.35 + float2(warpT, 0.0)),
                         fbm2(p * 0.35 + float2(0.0, warpT) + 17.3));
    float2 pw = p + warp * 0.6;
    float l1 = cCausticLayer(pw * 1.00, t * 0.50, 1.3);
    float l2 = cCausticLayer(pw * 1.37 + 9.1, -t * 0.40, 1.5);
    float caustic = l1 * 0.7 + l2 * 0.7 + l1 * l2 * 2.0;
    float wash = 0.5 + 0.5 * fbm2(p * 0.18 + float2(0.0, t * 0.12));
    float depth = smoothstep(-0.7, 0.7, uv.y) * 0.5 + 0.5 * wash;
    float3 water = lerp(uColorA.rgb, uColorB.rgb, depth);
    float lit = caustic * (0.55 + 0.75 * wash);
    float3 col = water + uColorC.rgb * lit;
    col += uColorC.rgb * pow(clamp(caustic, 0.0, 1.0), 3.0) * 0.35;
    float vig = 1.0 - 0.25 * dot(uv0 - 0.5, uv0 - 0.5);
    return col * vig;
}

// Cyclic 3-stop palette (A→B→C→A), shared by the three newer scenes.
float3 ncCyc(float x) {
    float f = frac(x);
    if (f < 0.3333) return lerp(uColorA.rgb, uColorB.rgb, f / 0.3333);
    if (f < 0.6666) return lerp(uColorB.rgb, uColorC.rgb, (f - 0.3333) / 0.3333);
    return lerp(uColorC.rgb, uColorA.rgb, (f - 0.6666) / 0.3334);
}

// ---- Scene 13: Liquid Chrome -----------------------------------------------
// Low-frequency warped surface reflecting a studio environment → big smooth
// mercury blobs that catch a crisp horizon highlight over a dark metal body.
float chromeHeight(float2 p, float t) {
    float2 w = float2(snoise(p * 0.18 + float2(0.0, t * 0.10)), snoise(p * 0.18 + float2(3.3, -t * 0.08)));
    return snoise(p * 0.22 + 1.2 * w);
}
float3 chromeEnv(float3 r) {
    float y = r.y;
    float g = smoothstep(-0.7, 0.7, y);
    float3 c = lerp(float3(0.02, 0.025, 0.035), float3(0.55, 0.62, 0.72), g);
    c += float3(1.0, 1.0, 1.0) * smoothstep(0.06, 0.0, abs(y)) * 0.8;
    float2 lp = float2(r.x + 0.4, r.y - 0.55);
    c += float3(1.0, 1.0, 1.0) * smoothstep(0.5, 0.0, length(lp)) * 0.7;
    return c;
}
float3 sceneChrome(float2 uv0, float aspect) {
    float scale = 1.2 / max(uSize, 0.0001);
    float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * scale;
    float t = uTime * uSpeed;
    float e = 0.02 * scale;
    float hx = chromeHeight(p + float2(e, 0.0), t) - chromeHeight(p - float2(e, 0.0), t);
    float hy = chromeHeight(p + float2(0.0, e), t) - chromeHeight(p - float2(0.0, e), t);
    float3 n = normalize(float3(-hx, -hy, e * 1.5));
    float3 view = float3(0.0, 0.0, 1.0);
    float3 refl = reflect(-view, n);
    float3 col = chromeEnv(refl);
    float3 tint = ncCyc(refl.y * 0.5 + 0.5 + t * 0.04);
    col = lerp(col, col * tint * 1.6, 0.25);
    float3 L = normalize(float3(cos(t * 0.25) * 0.7, 0.5 + 0.3 * sin(t * 0.2), 0.6));
    float3 H = normalize(L + view);
    float spec = pow(max(dot(n, H), 0.0), 200.0);
    col += float3(1.0, 1.0, 1.0) * spec * 2.0 * uIntensity;
    float fres = pow(1.0 - max(n.z, 0.0), 4.0);
    col += tint * fres * 0.3;
    float vig = 1.0 - 0.25 * dot(uv0 - 0.5, uv0 - 0.5);
    return col * vig;
}

// ---- Scene 14: Nebula Drift ------------------------------------------------
// Warped fbm gas with dust lanes, thresholded to glowing HDR filaments over
// black void, multi-hued, with cyan-white cores and a point-star field.
float ncStarField(float2 uv, float t) {
    float s = 0.0;
    [loop] for (int k = 0; k < 2; k++) {
        float sc = 110.0 + float(k) * 160.0;
        float2 g = uv * sc;
        float2 cell = floor(g);
        float2 f = frac(g) - 0.5;
        float h = hash21(cell + float(k) * 37.0);
        if (h > 0.88) {
            float2 off = (float2(hash21(cell + 1.3), hash21(cell + 4.7)) - 0.5) * 0.7;
            float d = length(f - off);
            float bright = (h - 0.88) / 0.12;
            s += smoothstep(0.08, 0.0, d) * bright * (0.5 + 0.5 * sin(t * 2.0 + h * 60.0));
        }
    }
    return s;
}
float3 sceneNebula(float2 uv0, float aspect) {
    float scale = 2.0 / max(uSize, 0.0001);
    float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
    float2 p = uv * scale;
    float t = uTime * uSpeed;
    float3 col = float3(0.0, 0.0, 0.0);
    float2 w = float2(fbm2(p * 0.5 + float2(0.0, t * 0.05)), fbm2(p * 0.5 + float2(5.2, 1.3) - t * 0.04));
    float d = fbm2(p * 0.7 + 1.7 * w);
    float dust = fbm2(p * 1.4 + 3.1 * w + float2(11.0, 4.0));
    float voidThr = lerp(0.46, 0.22, clamp(uDensity, 0.0, 1.0));
    float dens = clamp((d * 0.5 + 0.5 - voidThr - 0.34 * max(dust, 0.0)) / 0.62, 0.0, 1.0);
    float emission = pow(dens, 1.9);
    float hue = fbm2(p * 0.30 + float2(t * 0.02, 5.0)) * 0.6 + 0.5;
    float3 gas = ncCyc(hue + 0.25 * d);
    col += gas * emission * 3.2 * uIntensity;
    col += lerp(float3(0.6, 0.9, 1.0), float3(1.0, 0.96, 0.9), hue) * pow(dens, 5.0) * 2.0;
    float glow = exp(-dot(uv, uv) * 0.9);
    col += lerp(uColorB.rgb, uColorC.rgb, 0.4) * glow * 0.5;
    col += float3(0.9, 0.95, 1.0) * ncStarField(uv, t);
    col = col / (1.0 + col * 0.30);
    float vig = 1.0 - 0.28 * dot(uv0 - 0.5, uv0 - 0.5);
    return col * vig;
}

// ---- Scene 15: Fractal Bloom -----------------------------------------------
// Frame-filling animated Julia set; orbit-trap glow + smooth escape-time color.
// [loop] is REQUIRED: without it FXC unrolls the 100-iteration loop into a
// huge shader that stalls/TDRs the GPU (renders nothing). Metal runs it as a
// real loop, which is why macOS was unaffected.
float3 sceneFractal(float2 uv0, float aspect) {
    float t = uTime * uSpeed;
    float zoom = 1.3 * max(uSize, 0.0001);
    float2 z = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * zoom;
    float2 c = float2(-0.4, 0.6) + 0.12 * float2(cos(t * 0.13), sin(t * 0.17));
    float trap = 1e9;
    float it = 0.0;
    float r2 = 0.0;
    [loop] for (int i = 0; i < 100; i++) {
        z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
        r2 = dot(z, z);
        trap = min(trap, length(z));
        if (r2 > 64.0) break;
        it += 1.0;
    }
    float3 col;
    if (r2 <= 64.0) {
        col = ncCyc(trap * 2.0 + t * 0.05) * (0.3 + 0.6 * exp(-trap * 3.0));
    } else {
        float sm = it - log2(log2(r2)) + 4.0;
        col = ncCyc(sm * 0.04 + t * 0.05);
        col *= 0.4 + 0.6 * sin(sm * 0.3) * sin(sm * 0.3);
        col += uColorC.rgb * exp(-trap * 4.0) * (1.2 * uIntensity);
        col += float3(1.0, 1.0, 1.0) * pow(max(0.0, 1.0 - sm * 0.05), 3.0) * 0.3;
        col *= exp(-sm * 0.012);
    }
    float vig = 1.0 - 0.28 * dot(uv0 - 0.5, uv0 - 0.5);
    return col * vig;
}

float4 PSMain(VSOut inp) : SV_Target {
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    int s = int(uScene + 0.5);
    float3 col;
    if (s == 0)      col = sceneAurora(inp.uv, aspect);
    else if (s == 1) col = sceneRibbons(inp.uv, aspect);
    else if (s == 2) col = sceneDeepSpace(inp.uv, aspect);
    else if (s == 3) col = sceneParticles(inp.uv, aspect);
    else if (s == 4) col = scenePlasma(inp.uv, aspect);
    else if (s == 5) col = sceneMatrix(inp.uv, aspect);
    else if (s == 6) col = sceneFireflies(inp.uv, aspect);
    else if (s == 7) col = sceneBlackHole(inp.uv, aspect);
    else if (s == 8) col = sceneTunnel(inp.uv, aspect);
    else if (s == 9) col = sceneSynthwave(inp.uv, aspect);
    else if (s == 10) col = sceneKaleidoscope(inp.uv, aspect);
    else if (s == 11) col = sceneCaustics(inp.uv, aspect);
    else if (s == 12) col = scenePolar(inp.uv, aspect);
    else if (s == 13) col = sceneChrome(inp.uv, aspect);
    else if (s == 14) col = sceneNebula(inp.uv, aspect);
    else if (s == 15) col = sceneFractal(inp.uv, aspect);
    else             col = sceneAurora(inp.uv, aspect);
    col += ditherRGB(inp.pos.xy);
    return float4(col, 1.0);
}
