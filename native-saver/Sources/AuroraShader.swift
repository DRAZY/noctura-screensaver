import simd

/// CPU-side mirror of the `Uniforms` struct in the Metal shader. Field order,
/// types, and padding MUST match the MSL exactly — the struct is copied verbatim
/// to the GPU via `setFragmentBytes`. Total stride = 112 bytes.
struct AuroraUniforms {
    var time: Float = 0
    var speed: Float = 0.3
    var intensity: Float = 1.0
    var density: Float = 0.5
    var scene: Float = 0          // 0..12 — selects the active scene in the shader
    var month: Float = 0          // polar-clock month fraction
    var ticks: Float = 1          // polar-clock hour ticks 0/1
    var size: Float = 0.85        // element-size control (glyphs, fireflies, caustics)
    var resolution: SIMD2<Float> = .init(1, 1)
    var pad1: SIMD2<Float> = .init(0, 0)
    var colorA: SIMD4<Float> = .init(0.10, 0.07, 0.25, 1)
    var colorB: SIMD4<Float> = .init(0.78, 0.12, 0.54, 1)
    var colorC: SIMD4<Float> = .init(0.96, 0.65, 0.14, 1)
    var clock: SIMD4<Float> = .init(0, 0, 0, 0) // sec, min, hour, day fractions
}

/// Number of scenes the shader implements; mirrors `AuroraScene.all`.
let kAuroraSceneCount = 17

/// Multi-scene Metal Shading Language source, compiled at runtime via
/// `MTLDevice.makeLibrary(source:)` (the offline `metal` tool ships only with
/// full Xcode). A single fragment entry point branches on `u.scene` to render
/// one of eleven scenes — faithful MSL ports of the WebGL gallery, in the same
/// order: 0 Aurora Drift · 1 Northern Lights · 2 Deep Space · 3 Particle Drift ·
/// 4 Plasma Field · 5 Matrix Rain · 6 Fireflies · 7 Black Hole ·
/// 8 Hyperspace Tunnel · 9 Synthwave · 10 Kaleidoscope · 11 Polar Clock. The
/// final color is dithered to remove 8-bit banding, matching the web build.
enum AuroraShaderSource {
    static let metal = """
    #include <metal_stdlib>
    using namespace metal;

    struct Uniforms {
        float  time;
        float  speed;
        float  intensity;
        float  density;
        float  scene;
        float  month;
        float  ticks;
        float  size;
        float2 resolution;
        float2 pad1;
        float4 colorA;
        float4 colorB;
        float4 colorC;
        float4 clock;   // sec, min, hour, day
    };

    struct VertexOut {
        float4 position [[position]];
        float2 uv;
    };

    vertex VertexOut aurora_vertex(uint vid [[vertex_id]]) {
        float2 verts[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
        VertexOut out;
        float2 p = verts[vid];
        out.position = float4(p, 0.0, 1.0);
        out.uv = p * 0.5 + 0.5;
        return out;
    }

    // ---- 2D simplex noise ------------------------------------------------------
    static float3 mod289_3(float3 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
    static float2 mod289_2(float2 x) { return x - floor(x * (1.0/289.0)) * 289.0; }
    static float3 permute3(float3 x) { return mod289_3(((x * 34.0) + 1.0) * x); }

    static float snoise(float2 v) {
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
        float3 x = 2.0 * fract(p * C.www) - 1.0;
        float3 h = abs(x) - 0.5;
        float3 ox = floor(x + 0.5);
        float3 a0 = x - ox;
        m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
        float3 g;
        g.x  = a0.x  * x0.x  + h.x  * x0.y;
        g.yz = a0.yz * x12.xz + h.yz * x12.yw;
        return 130.0 * dot(m, g);
    }

    static float fbm2(float2 p) {
        float sum = 0.0, amp = 0.5, freq = 1.0;
        for (int i = 0; i < 5; i++) { sum += amp * snoise(p * freq); freq *= 2.0; amp *= 0.5; }
        return sum;
    }

    static float hash21(float2 p) {
        p = fract(p * float2(123.34, 345.45));
        p += dot(p, p + 34.345);
        return fract(p.x * p.y);
    }

    // ---- Dither: triangular-PDF ~±1 LSB to kill 8-bit gradient banding -------
    static float ditherHash(float2 p) {
        float3 p3 = fract(float3(p.x, p.y, p.x) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }
    static float3 ditherRGB(float2 fc) {
        float3 u1 = float3(ditherHash(fc), ditherHash(fc + 11.7), ditherHash(fc + 23.3));
        float3 u2 = float3(ditherHash(fc + 41.1), ditherHash(fc + 57.9), ditherHash(fc + 71.3));
        return (u1 + u2 - 1.0) / 255.0;
    }

    // ---- Scene 0: Aurora Drift -------------------------------------------------
    static float3 sceneAurora(float2 uv, constant Uniforms& u, float aspect) {
        float2 p = float2((uv.x - 0.5) * aspect, uv.y - 0.5) * 1.15;
        float t = u.time * u.speed;
        float2 q = float2(fbm2(p + 0.15*t), fbm2(p + float2(5.2,1.3) - 0.12*t));
        float2 r = float2(fbm2(p + 1.8*q + float2(1.7,9.2) + 0.10*t),
                          fbm2(p + 1.8*q + float2(8.3,2.8) - 0.08*t));
        float f = fbm2(p + 2.2*r);
        float m = clamp(f*0.5 + 0.5, 0.0, 1.0);
        float3 col = mix(u.colorA.rgb, u.colorB.rgb, smoothstep(0.0, 0.55, m));
        col = mix(col, u.colorC.rgb, smoothstep(0.45, 1.0, m));
        col += 0.06 * length(r) * u.intensity;
        return col;
    }

    // ---- Scene 1: Northern Lights ---------------------------------------------
    // Triangle-wave noise (after nimitz's "Auroras") — smooth flowing filaments,
    // no high-frequency aliasing.
    static float2x2 mm2(float a) { float c = cos(a), s = sin(a); return float2x2(c, s, -s, c); }
    static float tri(float x) { return clamp(abs(fract(x) - 0.5), 0.01, 0.49); }
    static float2 tri2(float2 p) { return float2(tri(p.x) + tri(p.y), tri(p.y + tri(p.x))); }
    static float triNoise2d(float2 p, float spd, float t) {
        float z = 1.8, z2 = 2.5, rz = 0.0;
        p = p * mm2(p.x * 0.06);
        float2 bp = p;
        for (float i = 0.0; i < 5.0; i++) {
            float2 dg = tri2(bp * 1.85) * 0.75;
            dg = dg * mm2(t * spd);
            p -= dg / z2;
            bp *= 1.3; z2 *= 0.45; z *= 0.42;
            p *= 1.21 + (rz - 1.0) * 0.02;
            rz += tri(p.x + tri(p.y)) * z;
            p = -(p * mm2(2.0));
        }
        return clamp(1.0 / pow(rz * 29.0, 1.3), 0.0, 0.55);
    }
    static float3 sceneRibbons(float2 uv0, constant Uniforms& u, float aspect) {
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y);
        float t = u.time * u.speed;
        float3 col = mix(u.colorA.rgb, u.colorA.rgb * 1.9, uv0.y);

        // Layered triangle-noise curtains with the vertical axis compressed so
        // filaments hang as rays, gently swayed side-to-side. All smooth.
        int layers = 4;
        float3 aur = float3(0.0);
        for (int i = 0; i < 5; i++) {
            if (i >= layers) break;
            float fl = float(i);
            float sway = 0.35 * sin(uv0.y * 2.0 + t * 0.3 + fl * 1.7);
            float2 ap = float2(uv.x * (1.25 + fl * 0.45) + sway + fl * 4.0,
                               uv0.y * 0.7 - t * (0.05 + fl * 0.03));
            float n = triNoise2d(ap, 0.05 + fl * 0.015, t);
            float vEnv = smoothstep(0.0, 0.28, uv0.y) * smoothstep(1.15, 0.45, uv0.y);
            float inten = n * vEnv;
            float3 lcol = mix(u.colorB.rgb, u.colorC.rgb, clamp(uv0.y * 1.05, 0.0, 1.0));
            lcol = mix(lcol, float3(0.72, 0.28, 0.96), smoothstep(0.6, 1.05, uv0.y) * 0.5);
            aur += lcol * inten * (1.5 - fl * 0.22);
        }
        col += aur * (1.1 * u.intensity);
        col += u.colorB.rgb * smoothstep(0.22, 0.0, uv0.y) * 0.12;
        col = col / (col + 0.7);
        return pow(col, float3(0.85));
    }

    // ---- Scene 2: Deep Space ---------------------------------------------------
    static float3 starLayer(float2 uv, float scale, float drift, float threshold, float3 tint, float time, float size) {
        uv = uv * scale + float2(drift, drift * 0.3);
        float2 cell = floor(uv);
        float2 f = fract(uv) - 0.5;
        float h = hash21(cell);
        float present = step(threshold, h);
        float2 starPos = (float2(hash21(cell + 1.7), hash21(cell + 4.1)) - 0.5) * 0.7;
        float d = length(f - starPos);
        float core = smoothstep(size, 0.0, d);
        float halo = smoothstep(size * 3.5, 0.0, d) * 0.35;
        float tw = 0.6 + 0.4 * sin(time * (1.5 + 3.0*h) + h*30.0);
        return tint * present * (core + halo) * tw;
    }
    static float3 sceneDeepSpace(float2 uv0, constant Uniforms& u, float aspect) {
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float t = u.time * u.speed;
        float nebAmt = u.intensity;
        float2 np = uv * 1.3 + float2(0.04*t, -0.02*t);
        float n = fbm2(np + fbm2(np * 1.7 + t * 0.05));
        float neb = smoothstep(-0.2, 0.85, n);
        float3 col = mix(u.colorA.rgb, u.colorB.rgb, neb * nebAmt);
        col += u.colorB.rgb * pow(max(n, 0.0), 3.0) * nebAmt * 0.9;       // bright cores
        float n2 = fbm2(np * 0.8 + float2(5.2, 1.7) - t * 0.03);
        col += u.colorC.rgb * smoothstep(0.45, 1.0, n2) * nebAmt * 0.2;    // cool depth tone
        float thr = mix(0.985, 0.93, clamp(u.density, 0.0, 1.0));
        col += starLayer(uv, 14.0, t*0.20, thr,        u.colorC.rgb,       u.time, 0.05) * 1.0;
        col += starLayer(uv,  9.0, t*0.12, thr+0.005,  u.colorC.rgb*0.9,   u.time, 0.06) * 0.8;
        col += starLayer(uv,  5.0, t*0.06, thr+0.008,  u.colorC.rgb*0.8,   u.time, 0.07) * 0.6;
        col += starLayer(uv,  3.0, t*0.03, thr+0.02,   u.colorC.rgb*1.4,   u.time, 0.10) * 1.5;
        return col;
    }

    // ---- Scene 3: Particle Drift -----------------------------------------------
    // Luminous points streaming through a curl-noise flow field, matching the
    // gallery app's FlowingParticles look: soft additive core+halo sprites
    // tinted base->accent by flow speed, over a near-black field, slow spin.
    static float3 sceneParticles(float2 uv0, constant Uniforms& u, float aspect) {
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * 2.2;
        float t = u.time * u.speed;
        // Slow rotation, mirroring the app's points.rotation.y = time * 0.03.
        float ca = cos(t * 0.03), sa = sin(t * 0.03);
        p = float2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
        float3 col = u.colorA.rgb * 0.05;
        float thr = mix(0.92, 0.55, clamp(u.density, 0.0, 1.0));
        for (int L = 0; L < 4; L++) {
            float fl = float(L);
            float scale = 5.0 + fl * 4.0;
            float2 fp = p * 0.7 + fl * 3.1;
            float2 flow = float2(fbm2(fp + float2(0.0, t * 0.15)),
                                 fbm2(fp + float2(5.2, 1.3) - t * 0.12));
            float flowLen = length(flow);
            float2 g = p * scale + flow * 1.8;
            float2 cell = floor(g);
            float2 f = fract(g) - 0.5;
            float h = hash21(cell + fl * 17.0);
            float present = step(thr, h);
            float2 pp = (float2(hash21(cell + 2.3), hash21(cell + 8.1)) - 0.5) * 0.7;
            float d = length(f - pp);
            // Bright core + soft halo → luminous additive bloom (matches app FRAG).
            float core = smoothstep(0.16, 0.0, d);
            float halo = smoothstep(0.42, 0.0, d) * 0.35;
            float glow = present * (1.6 * core + 0.5 * halo) * (0.5 + 0.5 * h);
            float3 tint = mix(u.colorB.rgb, u.colorC.rgb, clamp(flowLen * 0.9, 0.0, 1.0));
            col += tint * glow * (1.3 * u.intensity) * (1.0 - fl * 0.12);
        }
        return col;
    }

    // ---- Scene 11: Polar Clock -------------------------------------------------
    static float3 scenePolar(float2 uv0, constant Uniforms& u, float aspect) {
        const float TAU = 6.28318530718;
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float r = length(p);
        float ang = atan2(p.x, p.y);
        float frac = fract(ang / TAU);
        // Pixel-size derivatives → resolution-independent, razor-crisp edges.
        float aaR = fwidth(r);
        float aaA = min(fwidth(frac), 0.02);
        float3 col = u.colorA.rgb;
        float ht = 0.03 * 0.5;
        float fracs[5] = { u.clock.x, u.clock.y, u.clock.z, u.clock.w, u.month };
        for (int i = 0; i < 5; i++) {
            float radius = 0.40 - float(i) * 0.072;
            float ring = smoothstep(ht + aaR, ht - aaR, abs(r - radius));
            float3 tint = mix(u.colorC.rgb, u.colorB.rgb, float(i) / 6.0);
            col = mix(col, u.colorB.rgb * 0.7, ring * 0.35);
            float v = fracs[i];
            float arc = smoothstep(v + aaA, v - aaA, frac);
            col = mix(col, tint, ring * arc);
            col += tint * ring * arc * 0.22;
            // Glowing rounded cap at the arc's leading tip.
            float ha = v * TAU;
            float2 hp = float2(sin(ha), cos(ha)) * radius;
            float cap = smoothstep(ht * 1.5 + aaR, ht * 1.5 - aaR, length(p - hp));
            col += mix(tint, u.colorC.rgb, 0.5) * cap * smoothstep(0.0, 0.02, v) * 0.9;
        }
        if (u.ticks > 0.5) {
            float tp = abs(fract(frac * 12.0) - 0.5) * 2.0;
            float aaT = fwidth(tp);
            float tick = smoothstep(0.85 - aaT, 0.85 + aaT, tp);
            float tickRing = smoothstep(ht * 0.9 + aaR, ht * 0.9 - aaR, abs(r - 0.45));
            col = mix(col, u.colorC.rgb, tick * tickRing * 0.7);
        }
        return col;
    }

    // ---- Scene 4: Plasma Field -------------------------------------------------
    // Cyclic 3-stop palette so the plasma flows through many color bands.
    static float3 plasmaCyc(float x, float3 A, float3 B, float3 C) {
        float f = fract(x);
        if (f < 0.3333) return mix(A, B, f / 0.3333);
        if (f < 0.6666) return mix(B, C, (f - 0.3333) / 0.3333);
        return mix(C, A, (f - 0.6666) / 0.3334);
    }
    static float3 scenePlasma(float2 uv, constant Uniforms& u, float aspect) {
        float2 p = float2((uv.x - 0.5) * aspect, uv.y - 0.5) * 6.0;
        float t = u.time * u.speed;
        // Domain-warp so bands curl and fold.
        float2 w = p + float2(sin(t * 0.3 + p.y * 0.5), cos(t * 0.27 + p.x * 0.5)) * 1.2;
        float v = 0.0;
        v += sin(w.x * 1.2 + t);
        v += sin(w.y * 1.5 - t * 1.1);
        v += sin((w.x + w.y) * 0.9 + t * 0.7);
        v += sin((w.x - w.y) * 1.3 - t * 0.5);
        float2 c = p - float2(sin(t * 0.4), cos(t * 0.5)) * 2.5;
        v += 1.4 * sin(length(c) * 1.4 - t * 1.3);
        v *= 0.32;
        float3 col = plasmaCyc(v + t * 0.15, u.colorA.rgb, u.colorB.rgb, u.colorC.rgb);
        float crest = pow(abs(sin(v * 3.14159 * 2.0)), 10.0);
        col += u.colorC.rgb * crest * 0.6;
        float vig = 1.0 - 0.3 * dot(uv - 0.5, uv - 0.5);
        return col * vig;
    }

    // ---- Scene 5: Matrix Rain --------------------------------------------------
    // Encoded 5x7 katakana-style bitmap font (real glyph shapes). Each glyph's
    // 7 rows (5 bits, MSB = leftmost) are packed into two floats base-32: A holds
    // rows 0-3, B holds rows 4-6.
    static float2 mGlyphData(float i) {
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
    static float mGlyphBit(float gi, float col, float rowTop) {
        float2 d = mGlyphData(gi);
        float rowVal = rowTop < 3.5
            ? fmod(floor(d.x / pow(32.0, rowTop)), 32.0)
            : fmod(floor(d.y / pow(32.0, rowTop - 4.0)), 32.0);
        return fmod(floor(rowVal / pow(2.0, 4.0 - col)), 2.0);
    }
    static float3 sceneMatrix(float2 uv0, constant Uniforms& u, float aspect) {
        float density = clamp(u.density, 0.0, 1.0);
        // Size drives glyph footprint: smaller → many more, finer columns.
        float cols = floor(clamp(108.0 / clamp(u.size, 0.35, 2.5), 46.0, 240.0));
        float rows = floor((cols / aspect) * 0.62);
        float2 grid = float2(cols, rows);
        float2 uv = uv0 * grid;
        float2 cellId = floor(uv);
        float2 cellUv = fract(uv);
        float colSeed = hash21(float2(cellId.x, 7.0));
        float spd = u.speed * (0.5 + colSeed * 1.5);
        float head = fract(u.time * 0.15 * spd + colSeed) * rows;
        float dist = head - (rows - cellId.y);
        float tail = mix(30.0, 8.0, density);
        float bright = (dist >= 0.0) ? exp(-dist / tail) : 0.0;
        bright *= step(0.12, colSeed) * (0.6 + 0.4 * colSeed);   // some columns rest
        float frame = floor(u.time * 7.0 + hash21(cellId) * 12.0);
        float glyphId = floor(hash21(cellId + frame * 1.3) * 18.0);
        float flick = 0.82 + 0.18 * hash21(cellId + frame);
        float glint = step(0.94, hash21(cellId + frame * 2.0)) * 0.85;
        float2 m = float2(0.18, 0.07);
        float2 q = (cellUv - m) / (1.0 - 2.0 * m);
        float gm = 0.0;
        if (q.x >= 0.0 && q.x <= 1.0 && q.y >= 0.0 && q.y <= 1.0) {
            // Crisp sub-pixel AA on each lit cell so strokes stay fine, not blocky.
            float2 cell = float2(q.x * 5.0, (1.0 - q.y) * 7.0);
            float bit = mGlyphBit(glyphId, floor(cell.x), floor(cell.y));
            float2 f = fract(cell) - 0.5;
            float d = max(abs(f.x), abs(f.y));
            float aa = fwidth(d) + 0.002;
            gm = bit * smoothstep(0.5, 0.5 - aa - 0.05, d);
        }
        float headGlow = smoothstep(2.5, 0.0, dist);
        float3 charCol = mix(u.colorB.rgb, u.colorC.rgb, headGlow) + u.colorC.rgb * glint;
        float3 col = charCol * (gm * bright * flick) * u.intensity;
        col += u.colorB.rgb * bright * 0.04;   // faint column bloom
        return col;
    }

    // ---- Scene 6: Fireflies ----------------------------------------------------
    static float3 sceneFireflies(float2 uv0, constant Uniforms& u, float aspect) {
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float3 col = mix(u.colorA.rgb * 0.3, u.colorA.rgb, uv0.y);
        float t = u.time * u.speed;
        int count = int(mix(14.0, 48.0, clamp(u.density, 0.0, 1.0)));
        float glow = max(u.intensity, 0.3);
        float sz = clamp(u.size, 0.3, 3.0);   // Size scales each firefly's glow
        for (int i = 0; i < 48; i++) {
            if (i >= count) break;
            float fi = float(i);
            // Static hashed home plus a slow Lissajous wander. The previous
            // version called simplex noise twice here, but the result depended
            // only on (i, t) — identical for every pixel, so it was recomputed
            // millions of times per frame for nothing. Cheap trig gives the same
            // drifting-swarm look at ~10x lower cost.
            float2 home = (float2(hash21(float2(fi, 1.0)), hash21(float2(fi, 7.0))) - 0.5) * 2.0;
            float2 drift = float2(sin(t * 0.3 + fi * 1.7), sin(t * 0.27 + fi * 2.39 + 1.5707963));
            float2 pos = (home * 0.8 + drift * 0.22) * float2(aspect, 1.0) * 0.55;
            float pulse = 0.5 + 0.5 * sin(t * 2.0 + fi * 2.39);
            float d = length(uv - pos);
            float core = glow * (0.0009 * sz) / (d * d + 0.0006 * sz);
            col += u.colorC.rgb * core * (0.35 + 0.65 * pulse);
        }
        return col;
    }

    // ---- Scene 7: Black Hole ---------------------------------------------------
    static float3 sceneBlackHole(float2 uv0, constant Uniforms& u, float aspect) {
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float r = length(p);
        float a = atan2(p.y, p.x);
        float t = u.time * u.speed;
        float size = 1.6;
        float horizon = 0.13 * size;
        float ringR = 0.165 * size;
        float swirl = a + t * (0.6 / max(r, 0.05));
        // Sample disk noise on a CIRCLE so it is periodic in angle — no atan
        // branch-cut seam along the -X axis (the bug fixed in the web build).
        float2 swdir = float2(cos(swirl), sin(swirl)) * 1.6;
        float disk = fbm2(swdir + float2(r * 6.0 - t * 0.5, 0.0));
        disk = pow(clamp(disk * 0.5 + 0.5, 0.0, 1.0), 1.5);
        float band = smoothstep(horizon, ringR * 1.4, r) * (1.0 - smoothstep(0.5 * size, 1.1 * size, r));
        float3 diskCol = mix(u.colorB.rgb, u.colorC.rgb, disk) * disk * band * 2.2;
        float ring = exp(-pow((r - ringR) * 26.0, 2.0));
        diskCol += u.colorC.rgb * ring * 1.6;
        float hole = smoothstep(horizon * 0.75, horizon, r);
        float3 col = diskCol * hole;
        float lens = 1.0 - exp(-r * 3.0);
        float stars = step(0.997, snoise(p * 90.0 * lens));
        col += float3(stars) * 0.5 * hole;
        return col;
    }

    // ---- Scene 8: Hyperspace Tunnel --------------------------------------------
    static float3 sceneTunnel(float2 uv0, constant Uniforms& u, float aspect) {
        const float TAU = 6.28318530718;
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float r = length(p);
        float a = atan2(p.y, p.x);
        float t = u.time * u.speed;
        float depth = 0.35 / max(r, 0.04) + t * 2.0;
        // Periodic angular sampling (cos/sin) — seamless, no branch cut.
        float spin = a + depth * 0.22;
        float2 wdir = float2(cos(spin), sin(spin)) * 1.8;
        float wall = fbm2(wdir + float2(depth * 1.2, 0.0));
        float rings = 0.5 + 0.5 * sin(depth * TAU);
        float pat = mix(wall, rings, 0.4);
        float3 col = mix(u.colorA.rgb, u.colorB.rgb, pat);
        col = mix(col, u.colorC.rgb, smoothstep(0.5, 0.95, wall));
        // Radial light-speed streaks (integer angle multiple → seamless).
        float streak = pow(0.5 + 0.5 * sin(spin * 16.0 + t * 0.6), 6.0);
        streak *= 0.5 + 0.5 * sin(depth * 3.0);
        col += u.colorC.rgb * streak * smoothstep(0.12, 0.7, r) * 0.7;
        col *= smoothstep(0.03, 0.5, r);
        col *= 1.3;
        col += u.colorC.rgb * smoothstep(0.18, 0.0, r) * 1.9;
        return col;
    }

    // ---- Scene 9: Synthwave ----------------------------------------------------
    static float synthGridLine(float coord) {
        float w = fwidth(coord) * 1.5 + 0.02;
        float f = abs(fract(coord) - 0.5);
        return smoothstep(0.5 - w, 0.5, f);
    }
    static float3 sceneSynthwave(float2 uv, constant Uniforms& u, float aspect) {
        float t = u.time * u.speed;
        const float HORIZON = 0.5;
        float3 col;
        if (uv.y > HORIZON) {
            float sky = (uv.y - HORIZON) / (1.0 - HORIZON);
            col = mix(u.colorB.rgb * 0.55, u.colorA.rgb, pow(sky, 0.8));
            float2 sc = float2((uv.x - 0.5) * aspect, uv.y - 0.63);
            float sd = length(sc);
            float sunR = 0.17;
            float3 sunCol = mix(u.colorB.rgb, mix(u.colorB.rgb, float3(1.0, 0.95, 0.7), 0.6), clamp((0.63 - uv.y) / 0.34 + 0.5, 0.0, 1.0));
            float stripe = smoothstep(0.35, 0.65, fract((0.63 - uv.y) * 26.0));
            float gapMask = mix(1.0, stripe, smoothstep(0.63, 0.5, uv.y));
            float disc = smoothstep(sunR, sunR - 0.006, sd) * gapMask;
            col = mix(col, sunCol, disc);
            col += u.colorB.rgb * smoothstep(sunR * 2.6, 0.0, sd) * 0.45;
        } else {
            col = u.colorA.rgb * 0.12;
            float zy = HORIZON - uv.y;
            float persp = 0.10 / (zy + 0.0025);
            float gx = (uv.x - 0.5) * aspect * persp * 3.5;
            float gz = persp * 5.0 - t * 2.0;
            float line = max(synthGridLine(gx), synthGridLine(gz));
            float fade = smoothstep(0.0, 0.16, zy);
            col += u.colorC.rgb * line * fade * 1.3;
            col += u.colorB.rgb * smoothstep(0.16, 0.0, abs(uv.x - 0.5) * aspect) * smoothstep(0.0, 0.4, zy) * 0.15;
        }
        col += u.colorB.rgb * smoothstep(0.03, 0.0, abs(uv.y - HORIZON)) * 1.4;
        return col;
    }

    // ---- Scene 10: Kaleidoscope ------------------------------------------------
    static float2x2 kRot(float a) { float c = cos(a), s = sin(a); return float2x2(c, -s, s, c); }
    static float3 kCyc(float x, float3 A, float3 B, float3 C) {
        float f = fract(x);
        if (f < 0.3333) return mix(A, B, f / 0.3333);
        if (f < 0.6666) return mix(B, C, (f - 0.3333) / 0.3333);
        return mix(C, A, (f - 0.6666) / 0.3334);
    }
    static float3 sceneKaleidoscope(float2 uv0, constant Uniforms& u, float aspect) {
        const float TAU = 6.28318530718;
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float t = u.time * u.speed;
        p = kRot(t * 0.1) * p;
        float r = length(p);
        float a = atan2(p.y, p.x);
        float seg = TAU / 8.0;
        // GLSL `mod` is always non-negative; MSL `fmod` keeps the sign of `a`.
        // atan2 returns a in [-PI,PI], so fmod folds the lower half-plane
        // differently from the WebGL app — the "torn lines" seam. Reproduce
        // GLSL mod exactly: a - seg*floor(a/seg).
        a = abs((a - seg * floor(a / seg)) - seg * 0.5);
        // Clamp the breathing zoom so the petals never alias into torn lines.
        float zoom = 2.0 + 0.35 * sin(t * 0.2);
        float2 q = float2(cos(a), sin(a)) * r * zoom;
        float detail = smoothstep(0.03, 0.28, r);   // fade center singularity
        float n = fbm2(q * 1.15 + float2(t * 0.15, -t * 0.1));
        float phase = r * 11.0 - t * 1.4 + n * 2.5;
        float bands = 0.5 + 0.5 * sin(phase);
        float bw = max(fwidth(phase), 0.001);
        float petal = smoothstep(0.62 - bw, 0.62 + bw, bands);   // AA'd petal ridge
        float v = n * 1.2 * detail + bands * 0.35;
        float3 col = kCyc(v + t * 0.08, u.colorA.rgb, u.colorB.rgb, u.colorC.rgb);
        col += u.colorC.rgb * petal * 0.5 * detail;
        col *= 0.55 + 0.55 * smoothstep(1.4, 0.0, r);
        return col;
    }

    // ---- Scene 11: Caustics ----------------------------------------------------
    static float2 cCellPoint(float2 cell) {
        float h = dot(cell, float2(127.1, 311.7));
        float2 r = float2(sin(h) * 43758.5453, sin(h + 1.0) * 22578.1459);
        return fract(r);
    }
    // Worley returning nearest two distances; their difference (F2-F1) → 0 along
    // cell borders, the thin network real caustics trace.
    static float2 cWorley(float2 p, float t) {
        float2 base = floor(p);
        float2 f = fract(p);
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
    static float cCausticLayer(float2 p, float t, float sharp) {
        float2 w = cWorley(p, t);
        float border = w.y - w.x;
        float aa = fwidth(border) + 1e-4;
        float line = 1.0 - smoothstep(0.0, 0.07 + aa, border);
        return pow(clamp(line, 0.0, 1.0), sharp);
    }
    static float3 sceneCaustics(float2 uv0, constant Uniforms& u, float aspect) {
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float t = u.time * u.speed;
        float scale = 5.0;
        float2 p = uv * scale / max(u.size, 0.0001);
        float warpT = t * 0.35;
        float2 warp = float2(fbm2(p * 0.35 + float2(warpT, 0.0)),
                             fbm2(p * 0.35 + float2(0.0, warpT) + 17.3));
        float2 pw = p + warp * 0.6;
        float l1 = cCausticLayer(pw * 1.00, t * 0.50, 1.3);
        float l2 = cCausticLayer(pw * 1.37 + 9.1, -t * 0.40, 1.5);
        float caustic = l1 * 0.7 + l2 * 0.7 + l1 * l2 * 2.0;
        float wash = 0.5 + 0.5 * fbm2(p * 0.18 + float2(0.0, t * 0.12));
        float depth = smoothstep(-0.7, 0.7, uv.y) * 0.5 + 0.5 * wash;
        float3 water = mix(u.colorA.rgb, u.colorB.rgb, depth);
        float lit = caustic * (0.55 + 0.75 * wash);
        float3 col = water + u.colorC.rgb * lit;
        col += u.colorC.rgb * pow(clamp(caustic, 0.0, 1.0), 3.0) * 0.35;
        float vig = 1.0 - 0.25 * dot(uv0 - 0.5, uv0 - 0.5);
        return col * vig;
    }

    // Cyclic 3-stop palette (A→B→C→A), shared by the three newer scenes.
    static float3 ncCyc(constant Uniforms& u, float x) {
        float f = fract(x);
        if (f < 0.3333) return mix(u.colorA.rgb, u.colorB.rgb, f / 0.3333);
        if (f < 0.6666) return mix(u.colorB.rgb, u.colorC.rgb, (f - 0.3333) / 0.3333);
        return mix(u.colorC.rgb, u.colorA.rgb, (f - 0.6666) / 0.3334);
    }

    // ---- Scene 13: Liquid Chrome -------------------------------------------
    // Low-frequency warped surface reflecting a studio environment → big smooth
    // mercury blobs that catch a crisp horizon highlight over a dark metal body.
    static float chromeHeight(float2 p, float t) {
        float2 w = float2(snoise(p * 0.18 + float2(0.0, t * 0.10)), snoise(p * 0.18 + float2(3.3, -t * 0.08)));
        return snoise(p * 0.22 + 1.2 * w);
    }
    static float3 chromeEnv(float3 r) {
        float y = r.y;
        float g = smoothstep(-0.7, 0.7, y);
        float3 c = mix(float3(0.02, 0.025, 0.035), float3(0.55, 0.62, 0.72), g);
        c += float3(1.0) * smoothstep(0.06, 0.0, abs(y)) * 0.8;
        float2 lp = float2(r.x + 0.4, r.y - 0.55);
        c += float3(1.0) * smoothstep(0.5, 0.0, length(lp)) * 0.7;
        return c;
    }
    static float3 sceneChrome(float2 uv0, constant Uniforms& u, float aspect) {
        float scale = 1.2 / max(u.size, 0.0001);
        float2 p = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * scale;
        float t = u.time * u.speed;
        float e = 0.02 * scale;
        float hx = chromeHeight(p + float2(e, 0.0), t) - chromeHeight(p - float2(e, 0.0), t);
        float hy = chromeHeight(p + float2(0.0, e), t) - chromeHeight(p - float2(0.0, e), t);
        float3 n = normalize(float3(-hx, -hy, e * 1.5));
        float3 view = float3(0.0, 0.0, 1.0);
        float3 refl = reflect(-view, n);
        float3 col = chromeEnv(refl);
        float3 tint = ncCyc(u, refl.y * 0.5 + 0.5 + t * 0.04);
        col = mix(col, col * tint * 1.6, 0.25);
        float3 L = normalize(float3(cos(t * 0.25) * 0.7, 0.5 + 0.3 * sin(t * 0.2), 0.6));
        float3 H = normalize(L + view);
        float spec = pow(max(dot(n, H), 0.0), 200.0);
        col += float3(1.0) * spec * 2.0 * u.intensity;
        float fres = pow(1.0 - max(n.z, 0.0), 4.0);
        col += tint * fres * 0.3;
        float vig = 1.0 - 0.25 * dot(uv0 - 0.5, uv0 - 0.5);
        return col * vig;
    }

    // ---- Scene 14: Nebula Drift --------------------------------------------
    // Warped fbm gas with dust lanes, thresholded to glowing HDR filaments over
    // black void, multi-hued, with cyan-white cores and a point-star field.
    static float ncStarField(float2 uv, float t) {
        float s = 0.0;
        for (int k = 0; k < 2; k++) {
            float sc = 110.0 + float(k) * 160.0;
            float2 g = uv * sc;
            float2 cell = floor(g);
            float2 f = fract(g) - 0.5;
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
    static float3 sceneNebula(float2 uv0, constant Uniforms& u, float aspect) {
        float scale = 2.0 / max(u.size, 0.0001);
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float2 p = uv * scale;
        float t = u.time * u.speed;
        float3 col = float3(0.0);
        float2 w = float2(fbm2(p * 0.5 + float2(0.0, t * 0.05)), fbm2(p * 0.5 + float2(5.2, 1.3) - t * 0.04));
        float d = fbm2(p * 0.7 + 1.7 * w);
        float dust = fbm2(p * 1.4 + 3.1 * w + float2(11.0, 4.0));
        float voidThr = mix(0.46, 0.22, clamp(u.density, 0.0, 1.0));
        float dens = clamp((d * 0.5 + 0.5 - voidThr - 0.34 * max(dust, 0.0)) / 0.62, 0.0, 1.0);
        float emission = pow(dens, 1.9);
        float hue = fbm2(p * 0.30 + float2(t * 0.02, 5.0)) * 0.6 + 0.5;
        float3 gas = ncCyc(u, hue + 0.25 * d);
        col += gas * emission * 3.2 * u.intensity;
        col += mix(float3(0.6, 0.9, 1.0), float3(1.0, 0.96, 0.9), hue) * pow(dens, 5.0) * 2.0;
        float glow = exp(-dot(uv, uv) * 0.9);
        col += mix(u.colorB.rgb, u.colorC.rgb, 0.4) * glow * 0.5;
        col += float3(0.9, 0.95, 1.0) * ncStarField(uv, t);
        col = col / (1.0 + col * 0.30);
        float vig = 1.0 - 0.28 * dot(uv0 - 0.5, uv0 - 0.5);
        return col * vig;
    }

    // ---- Scene 15: Fractal Bloom -------------------------------------------
    // Frame-filling animated Julia set; orbit-trap glow + smooth escape-time color.
    static float3 sceneFractal(float2 uv0, constant Uniforms& u, float aspect) {
        float t = u.time * u.speed;
        float zoom = 1.3 * max(u.size, 0.0001);
        float2 z = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5) * zoom;
        float2 c = float2(-0.4, 0.6) + 0.12 * float2(cos(t * 0.13), sin(t * 0.17));
        float trap = 1e9;
        float it = 0.0;
        float r2 = 0.0;
        for (int i = 0; i < 100; i++) {
            z = float2(z.x * z.x - z.y * z.y, 2.0 * z.x * z.y) + c;
            r2 = dot(z, z);
            trap = min(trap, length(z));
            if (r2 > 64.0) break;
            it += 1.0;
        }
        float3 col;
        if (r2 <= 64.0) {
            col = ncCyc(u, trap * 2.0 + t * 0.05) * (0.3 + 0.6 * exp(-trap * 3.0));
        } else {
            float sm = it - log2(log2(r2)) + 4.0;
            col = ncCyc(u, sm * 0.04 + t * 0.05);
            col *= 0.4 + 0.6 * sin(sm * 0.3) * sin(sm * 0.3);
            col += u.colorC.rgb * exp(-trap * 4.0) * (1.2 * u.intensity);
            col += float3(1.0) * pow(max(0.0, 1.0 - sm * 0.05), 3.0) * 0.3;
            col *= exp(-sm * 0.012);
        }
        float vig = 1.0 - 0.28 * dot(uv0 - 0.5, uv0 - 0.5);
        return col * vig;
    }

    // ---- Scene 16: Flux Drift --------------------------------------------------
    // Homage to macOS "Drift" and its open tribute Flux (github.com/sandydoo/flux):
    // long luminous streaks combed along a slow divergence-free flow field, piling
    // up additively into flowing ribbons that curl around vortices — bright in fast
    // current, black in calm — over big soft palette-colour zones. Faithful port of
    // the validated WebGL scene (see docs/DRIFT_FLUX_RESEARCH.md). Size → swirl
    // scale, density → grid, intensity → glow, colours from the palette.
    static float driftHash(float2 p) {
        p = fract(p * float2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }
    // --- 3D simplex noise (Ashima) for the time-evolving stream function ---------
    static float4 s3mod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    static float3 s3mod289(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
    static float4 s3permute(float4 x) { return s3mod289(((x * 34.0) + 1.0) * x); }
    static float4 s3tis(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
    static float snoise3(float3 v) {
        const float2 C = float2(1.0/6.0, 1.0/3.0);
        const float4 D = float4(0.0, 0.5, 1.0, 2.0);
        float3 i  = floor(v + dot(v, C.yyy));
        float3 x0 = v - i + dot(i, C.xxx);
        float3 g = step(x0.yzx, x0.xyz);
        float3 l = 1.0 - g;
        float3 i1 = min(g.xyz, l.zxy);
        float3 i2 = max(g.xyz, l.zxy);
        float3 x1 = x0 - i1 + C.xxx;
        float3 x2 = x0 - i2 + C.yyy;
        float3 x3 = x0 - D.yyy;
        i = s3mod289(i);
        float4 p = s3permute(s3permute(s3permute(
                    i.z + float4(0.0, i1.z, i2.z, 1.0))
                  + i.y + float4(0.0, i1.y, i2.y, 1.0))
                  + i.x + float4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        float3 ns = n_ * D.wyz - D.xzx;
        float4 j = p - 49.0 * floor(p * ns.z * ns.z);
        float4 x_ = floor(j * ns.z);
        float4 y_ = floor(j - 7.0 * x_);
        float4 x = x_ * ns.x + ns.yyyy;
        float4 y = y_ * ns.x + ns.yyyy;
        float4 h = 1.0 - abs(x) - abs(y);
        float4 b0 = float4(x.xy, y.xy);
        float4 b1 = float4(x.zw, y.zw);
        float4 s0 = floor(b0) * 2.0 + 1.0;
        float4 s1 = floor(b1) * 2.0 + 1.0;
        float4 sh = -step(h, float4(0.0));
        float4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
        float4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
        float3 p0 = float3(a0.xy, h.x);
        float3 p1 = float3(a0.zw, h.y);
        float3 p2 = float3(a1.xy, h.z);
        float3 p3 = float3(a1.zw, h.w);
        float4 norm = s3tis(float4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        float4 m = max(0.6 - float4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m * m, float4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
    }
    // Cheap flow stream-function: a single octave of 2D simplex whose sample point
    // drifts slowly with time. This gives a smooth, slowly-evolving divergence-free
    // field for ~1/5th the cost of the 3D-noise version — the dominant cost lever
    // in this scene, which is sampled ~(2*SEARCH+1)^2 * KSTEPS times per pixel.
    static float driftPsi(float2 p, float t) {
        float2 dr = float2(t * 0.06, -t * 0.045);
        return snoise(p * 0.9 + dr);
    }
    static float2 driftVel(float2 p, float t) {
        const float e = 0.9;
        float c  = driftPsi(p, t);                        // forward diff: 3 taps, not 4
        float dx = driftPsi(p + float2(e, 0.0), t) - c;
        float dy = driftPsi(p + float2(0.0, e), t) - c;
        // Curl → divergence-free, plus a small constant laminar bias that keeps the
        // flow moving where the noise gradient vanishes (kills the radial
        // "starburst" singularities that short streaks otherwise expose). Bias
        // lowered to match the validated web scene: gentler drift, more coherent.
        return float2(dy, -dx) / e + float2(0.12, 0.05);
    }
    static float3 sceneDrift(float2 uv0, constant Uniforms& u, float aspect) {
        float2 uv = float2((uv0.x - 0.5) * aspect, uv0.y - 0.5);
        float t = u.time * u.speed;
        // Lower swirl frequency than before → smoother, more coherent streams, matching
        // the validated web scene (DEFAULT_FLOW = 1.3).
        float flow = 1.3 * clamp(u.size * 1.05, 0.6, 1.7);
        // Denser grid → short dashes with fine texture (cost is a fixed per-pixel
        // neighbourhood, so a finer grid is essentially free).
        float grid = mix(70.0, 110.0, clamp(u.density, 0.0, 1.0));
        float glow = 1.0 + u.intensity;
        const int KSTEPS = 3;
        const int SEARCH = 1;   // 3×3 neighbourhood — the finer grid keeps dashes short,
                                // so the wider 5×5 reach is unnecessary (≈2.7× cheaper).
        const float LINE_BEGIN_OFFSET = 0.4;
        const float LINE_VARIANCE = 0.55;
        const float HALF_WIDTH = 0.20;
        const float HEAD_GLOW = 0.22;

        float cell = 1.0 / grid;
        float2 baseId = floor(uv / cell);
        float lenCells = 2.0;   // dash length in cells (decoupled from SEARCH)
        float accum = 0.0;
        for (int j = -SEARCH; j <= SEARCH; j++) {
            for (int i = -SEARCH; i <= SEARCH; i++) {
                float2 cellId = baseId + float2(float(i), float(j));
                // Jittered basepoint (Flux grid_spacing + jitter) so streams don't
                // read as a rigid lattice.
                float2 jit = (float2(driftHash(cellId), driftHash(cellId + 7.3)) - 0.5) * 0.7;
                float2 bp = (cellId + 0.5 + jit) * cell;
                float2 v0 = driftVel(bp * flow, t);
                // Steeper, higher-threshold speed gate (web: clamp(1.7*speed-0.25)):
                // calm flow → 0 so those cells fall to pure black (negative space).
                float boost = smoothstep(0.0, 1.0, clamp(1.7 * length(v0) - 0.25, 0.0, 1.0));
                if (boost < 0.01) continue;
                float rnd = driftHash(cellId);
                float variance = mix(1.0 - LINE_VARIANCE, 1.0, rnd);
                float lineLen = lenCells * cell * boost * variance;
                float halfW = max(HALF_WIDTH * cell * boost, 2.2 * fwidth(uv.y)); // floor to ~2px so strokes survive low-res panic
                if (lineLen < 1e-5) continue;
                if (dot(uv - bp, uv - bp) > (lineLen + halfW) * (lineLen + halfW)) continue;
                float ds = lineLen / float(KSTEPS);
                float2 pPrev = bp;
                float2 vPrev = v0;                    // reuse the boost-check sample
                float best = 1e9, bestS = 0.0, arc = 0.0;
                for (int k = 0; k < KSTEPS; k++) {    // Euler integration (one velocity/step)
                    float2 dk = vPrev / max(length(vPrev), 1e-5);
                    float2 pNext = pPrev + dk * ds;
                    float2 pa = uv - pPrev, ba = pNext - pPrev;
                    float hh = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
                    float d = length(pa - ba * hh);
                    float s = (arc + hh * ds) / lineLen;
                    if (d < best) { best = d; bestS = s; }
                    arc += ds; pPrev = pNext;
                    vPrev = driftVel(pPrev * flow, t);
                }
                float fade = smoothstep(LINE_BEGIN_OFFSET, 1.0, bestS);
                float aa = min(1.5 * fwidth(uv.y), halfW * 0.9) + 1e-5; // capped to halfW so thin strokes survive low res
                float edge = 1.0 - smoothstep(halfW - aa, halfW, best);
                // Squared speed weighting (web folds vBright²): fast flow lights up,
                // everything else stays dark → the breathing negative space of real Drift.
                float alpha = boost * boost * fade * edge;
                if (alpha <= 0.0) continue;
                alpha += HEAD_GLOW * smoothstep(0.8, 1.0, bestS) * edge * boost;
                accum += alpha;
            }
        }

        float creg = 0.7 * snoise(uv * flow * 0.22 + float2(t * 0.05, 0.0))
                   + 0.55 * (uv.x + uv.y) + 0.04 * t;
        float3 tint = ncCyc(u, creg);
        // Pull the palette toward its own luma → dusty, desaturated tones (the web
        // scene's rose/seafoam/periwinkle look) instead of hard neon, while still
        // honouring the user's chosen colours. Additive overlap lifts crossings to cream.
        float l = dot(tint, float3(0.299, 0.587, 0.114));
        tint = mix(float3(l), tint, 0.72);
        float3 outc = float3(0.012, 0.010, 0.030) + tint * accum * glow;
        float vig = 1.0 - 0.26 * dot(uv0 - 0.5, uv0 - 0.5);
        outc *= vig;
        outc = outc / (outc + 0.85);
        outc = pow(outc, float3(0.85));
        return outc;
    }

    fragment float4 aurora_fragment(VertexOut in [[stage_in]],
                                    constant Uniforms& u [[buffer(0)]]) {
        float aspect = u.resolution.x / max(u.resolution.y, 1.0);
        int s = int(u.scene + 0.5);
        float3 col;
        if (s == 0)      col = sceneAurora(in.uv, u, aspect);
        else if (s == 1) col = sceneRibbons(in.uv, u, aspect);
        else if (s == 2) col = sceneDeepSpace(in.uv, u, aspect);
        else if (s == 3) col = sceneParticles(in.uv, u, aspect);
        else if (s == 4) col = scenePlasma(in.uv, u, aspect);
        else if (s == 5) col = sceneMatrix(in.uv, u, aspect);
        else if (s == 6) col = sceneFireflies(in.uv, u, aspect);
        else if (s == 7) col = sceneBlackHole(in.uv, u, aspect);
        else if (s == 8) col = sceneTunnel(in.uv, u, aspect);
        else if (s == 9) col = sceneSynthwave(in.uv, u, aspect);
        else if (s == 10) col = sceneKaleidoscope(in.uv, u, aspect);
        else if (s == 11) col = sceneCaustics(in.uv, u, aspect);
        else if (s == 12) col = scenePolar(in.uv, u, aspect);
        else if (s == 13) col = sceneChrome(in.uv, u, aspect);
        else if (s == 14) col = sceneNebula(in.uv, u, aspect);
        else if (s == 15) col = sceneFractal(in.uv, u, aspect);
        else if (s == 16) col = sceneDrift(in.uv, u, aspect);
        else             col = sceneAurora(in.uv, u, aspect);
        // Dither the final color to break up 8-bit banding (matches web build).
        col += ditherRGB(in.position.xy);
        return float4(col, 1.0);
    }
    """
}
