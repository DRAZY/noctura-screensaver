// Faithful sandydoo/Flux port — 1:1 with AuroraFluxFluid.swift's MSL and the web
// Drift.ts (verified against flux.sandydoo.me). Compiled at runtime via D3DCompile.
// Entry points: fs_vertex, noise_frag, advect_frag, adjust_frag, diffuse_frag,
// inject_frag, divergence_frag, pressure_frag, subtract_frag, place_frag,
// line_vertex, line_fragment, endpoint_vertex, endpoint_fragment, encode_frag.
//
// RESERVED-WORD NOTE: `point`, `line`, `linear`, `sample`, `pass`, `half`,
// `matrix`, `vector`, `texture`, `sampler`, `clip` are HLSL keywords/intrinsics
// that MSL/GLSL allow as identifiers — FXC rejects them (this silently broke the
// scene once). None are used as identifiers below; keep it that way.

SamplerState samplerLinearClamp : register(s0);

cbuffer FluidParams : register(b1)
{
    float amount;
    float dissipation;
    float alpha;
    float rBeta;
    float deltaTime;
    float fluidPad0;
    float2 texel;
    float4 chScale;    // per-channel noise scale (breathes)
    float4 chMult;     // per-channel multiplier
    float4 chOffset1;  // per-channel offset 1
    float4 chOffset2;  // per-channel offset 2
    float4 chBlend;    // per-channel crossfade factor
};

// Float4-packed to sidestep HLSL cbuffer register packing pitfalls; the Rust
// mirror is [[f32; 4]; 4] + [[f32; 4]; 6].
cbuffer LineParams : register(b2)
{
    float4 gridA;   // cols, rows, baseSpacing.x, baseSpacing.y
    float4 gridB;   // lineNoiseScale.x, lineNoiseScale.y, noiseOffset1, aspect
    float4 lineA;   // zoom, lineLength, lineWidth, beginOffset
    float4 lineB;   // lineVariance, deltaTime(line), glow, colorMode (0/1 as float)
    float4 wheel[6];
};

Texture2D<float4> gTex0 : register(t0);
Texture2D<float4> gTex1 : register(t1);
Texture2D<float4> gTex2 : register(t2);
Texture2D<float4> gTex3 : register(t3);

struct FSOut
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

FSOut fs_vertex(uint vid : SV_VertexID)
{
    float2 v[3] = { float2(-1.0, -1.0), float2(3.0, -1.0), float2(-1.0, 3.0) };
    FSOut o;
    float2 p = v[vid];
    o.position = float4(p, 0.0, 1.0);
    o.uv = p * 0.5 + 0.5;
    return o;
}

// ---- 3D simplex noise (Ashima, same as Flux) ----------------------------------
float3 mod289(float3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float4 mod289(float4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
float4 permute(float4 x) { return mod289(((x * 34.0) + 1.0) * x); }
float4 taylorInvSqrt(float4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(float3 v)
{
    const float2 C = float2(1.0 / 6.0, 1.0 / 3.0);
    float3 i = floor(v + dot(v, C.yyy));
    float3 x0 = v - i + dot(i, C.xxx);
    float3 g = step(x0.yzx, x0.xyz);
    float3 l = 1.0 - g;
    float3 i1 = min(g.xyz, l.zxy);
    float3 i2 = max(g.xyz, l.zxy);
    float3 x1 = x0 - i1 + C.xxx;
    float3 x2 = x0 - i2 + C.yyy;
    float3 x3 = x0 - 0.5;
    i = mod289(i);
    float4 p = permute(permute(permute(i.z + float4(0.0, i1.z, i2.z, 1.0))
                                     + i.y + float4(0.0, i1.y, i2.y, 1.0))
                                     + i.x + float4(0.0, i1.x, i2.x, 1.0));
    float4 j = p - 49.0 * floor(p * (1.0 / 49.0));
    float4 x_ = floor(j * (1.0 / 7.0));
    float4 y_ = floor(j - 7.0 * x_);
    float4 x = x_ * (2.0 / 7.0) + 0.5 / 7.0 - 1.0;
    float4 y = y_ * (2.0 / 7.0) + 0.5 / 7.0 - 1.0;
    float4 h = 1.0 - abs(x) - abs(y);
    float4 b0 = float4(x.xy, y.xy);
    float4 b1 = float4(x.zw, y.zw);
    float4 s0 = floor(b0) * 2.0 + 1.0;
    float4 s1 = floor(b1) * 2.0 + 1.0;
    float4 sh = -step(h, float4(0.0, 0.0, 0.0, 0.0));
    float4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    float4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    float3 g0 = float3(a0.xy, h.x);
    float3 g1 = float3(a0.zw, h.y);
    float3 g2 = float3(a1.xy, h.z);
    float3 g3 = float3(a1.zw, h.w);
    float4 norm = taylorInvSqrt(float4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
    g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
    float4 m = max(0.6 - float4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    m = m * m;
    float4 px = float4(dot(x0, g0), dot(x1, g1), dot(x2, g2), dot(x3, g3));
    return 42.0 * dot(m, px);
}

// ---- Fluid passes (identical math to the web FluxFluid.ts) ---------------------
float2 makePair(float3 p) { return float2(snoise(p), snoise(p + float3(8.0, -8.0, 0.0))); }
float2 noiseChannel(float2 uv, float scaleVal, float mult, float off1, float off2, float blendF)
{
    float2 pos = scaleVal * uv;
    float2 n = makePair(float3(pos, off1));
    if (blendF > 0.0)
    {
        n = lerp(n, makePair(float3(pos, off2)), blendF);
    }
    return mult * n;
}

float4 noise_frag(FSOut fsIn) : SV_Target
{
    float2 n = noiseChannel(fsIn.uv, chScale.x, chMult.x, chOffset1.x, chOffset2.x, chBlend.x)
             + noiseChannel(fsIn.uv, chScale.y, chMult.y, chOffset1.y, chOffset2.y, chBlend.y)
             + noiseChannel(fsIn.uv, chScale.z, chMult.z, chOffset1.z, chOffset2.z, chBlend.z);
    return float4(n * 0.45, 0.0, 1.0);
}

float4 advect_frag(FSOut fsIn) : SV_Target
{
    float w, h;
    gTex0.GetDimensions(w, h);
    float2 size = float2(w, h);
    float2 texelPos = floor(size * fsIn.uv);
    float2 velocity = gTex0.Load(int3(int(texelPos.x), int(texelPos.y), 0)).xy;
    float2 advectedPos = ((texelPos + 0.5) - amount * velocity) / size;
    float decay = 1.0 + dissipation * amount;
    return float4(gTex0.SampleLevel(samplerLinearClamp, advectedPos, 0.0).xy / decay, 0.0, 1.0);
}

float4 adjust_frag(FSOut fsIn) : SV_Target
{
    float w, h;
    gTex0.GetDimensions(w, h);
    float2 size = float2(w, h);
    int2 pos = int2(floor(fsIn.uv * size));
    float2 velocity = gTex0.Load(int3(pos, 0)).xy;
    float2 sp = (0.5 + floor((float2(pos) + 1.0) - deltaTime * velocity)) / size;
    float2 t = 1.0 / size;
    float2 L = gTex0.SampleLevel(samplerLinearClamp, sp + float2(-t.x, 0.0), 0.0).xy;
    float2 R = gTex0.SampleLevel(samplerLinearClamp, sp + float2(t.x, 0.0), 0.0).xy;
    float2 T = gTex0.SampleLevel(samplerLinearClamp, sp + float2(0.0, t.y), 0.0).xy;
    float2 B = gTex0.SampleLevel(samplerLinearClamp, sp + float2(0.0, -t.y), 0.0).xy;
    float2 lo = min(L, min(R, min(T, B)));
    float2 hi = max(L, max(R, max(T, B)));
    float2 fwdV = gTex1.Load(int3(pos, 0)).xy;
    float2 revV = gTex2.Load(int3(pos, 0)).xy;
    float2 adjusted = fwdV + 0.5 * (velocity - revV);
    return float4(clamp(adjusted, lo, hi), 0.0, 1.0);
}

float4 diffuse_frag(FSOut fsIn) : SV_Target
{
    float w, h;
    gTex0.GetDimensions(w, h);
    float2 size = float2(w, h);
    float2 velocity = gTex0.Load(int3(int2(floor(size * fsIn.uv)), 0)).xy;
    float2 t = texel;
    float2 L = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(-t.x, 0.0), 0.0).xy;
    float2 R = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(t.x, 0.0), 0.0).xy;
    float2 T = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, t.y), 0.0).xy;
    float2 B = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, -t.y), 0.0).xy;
    return float4(rBeta * (L + R + B + T + alpha * velocity), 0.0, 1.0);
}

float4 inject_frag(FSOut fsIn) : SV_Target
{
    float2 velocity = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv, 0.0).xy;
    float2 n = gTex1.SampleLevel(samplerLinearClamp, fsIn.uv, 0.0).xy;
    return float4(velocity + deltaTime * n, 0.0, 1.0);
}

float4 divergence_frag(FSOut fsIn) : SV_Target
{
    float2 t = texel;
    float L = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(-t.x, 0.0), 0.0).x;
    float R = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(t.x, 0.0), 0.0).x;
    float T = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, t.y), 0.0).y;
    float B = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, -t.y), 0.0).y;
    return float4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}

float4 pressure_frag(FSOut fsIn) : SV_Target
{
    float w, h;
    gTex1.GetDimensions(w, h);
    float2 size = float2(w, h);
    float d = gTex1.Load(int3(int2(floor(size * fsIn.uv)), 0)).x;
    float2 t = texel;
    float L = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(-t.x, 0.0), 0.0).x;
    float R = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(t.x, 0.0), 0.0).x;
    float T = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, t.y), 0.0).x;
    float B = gTex0.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, -t.y), 0.0).x;
    return float4(rBeta * (L + R + B + T + alpha * d), 0.0, 0.0, 1.0);
}

float4 subtract_frag(FSOut fsIn) : SV_Target
{
    float w, h;
    gTex0.GetDimensions(w, h);
    float2 size = float2(w, h);
    float2 t = texel;
    float L = gTex1.SampleLevel(samplerLinearClamp, fsIn.uv + float2(-t.x, 0.0), 0.0).x;
    float R = gTex1.SampleLevel(samplerLinearClamp, fsIn.uv + float2(t.x, 0.0), 0.0).x;
    float T = gTex1.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, t.y), 0.0).x;
    float B = gTex1.SampleLevel(samplerLinearClamp, fsIn.uv + float2(0.0, -t.y), 0.0).x;
    float2 v = gTex0.Load(int3(int2(floor(size * fsIn.uv)), 0)).xy;
    float2 boundary = float2(1.0, 1.0);
    if (fsIn.uv.x < t.x || fsIn.uv.x > 1.0 - t.x) boundary.x = 0.0;
    if (fsIn.uv.y < t.y || fsIn.uv.y > 1.0 - t.y) boundary.y = 0.0;
    return float4(boundary * (v - 0.5 * float2(R - L, T - B)), 0.0, 1.0);
}

// ---- place_lines (Flux place_lines as an MRT pass over 3 state textures) -------
// gTex0 = fluid velocity, gTex1..3 = previous state 0..2.
// SV_Target0 endpoint+springVel, 1 color+width, 2 colorVel+opacity.
struct PlaceOut
{
    float4 endVel : SV_Target0;
    float4 colorWidth : SV_Target1;
    float4 colorVel : SV_Target2;
};

float3 wheelColor(float angle)
{
    const float TAU = 6.283185307179586;
    float slice = TAU / 6.0;
    float wrapped = fmod(fmod(angle, TAU) + TAU, TAU);
    float rawIndex = wrapped / slice;
    float index = floor(rawIndex);
    float nextIndex = fmod(index + 1.0, 6.0);
    return lerp(wheel[int(index)].rgb, wheel[int(nextIndex)].rgb, frac(rawIndex));
}

PlaceOut place_frag(FSOut fsIn)
{
    int2 tc = int2(fsIn.position.xy);
    float2 baseSpacing = gridA.zw;
    float2 basepoint = float2(tc) * baseSpacing;
    float2 velocity = gTex0.SampleLevel(samplerLinearClamp, basepoint, 0.0).xy;
    float4 st = gTex1.Load(int3(tc, 0));
    float4 cw = gTex2.Load(int3(tc, 0));
    float4 cv = gTex3.Load(int3(tc, 0));

    float lineVariance = lineB.x;
    float dtLine = lineB.y;
    float lineLength = lineA.y;

    float n = snoise(float3(gridB.xy * basepoint, gridB.z));
    float variance = lerp(1.0 - lineVariance, 1.0, 0.5 + 0.5 * n);
    float velocityDeltaBoost = lerp(3.0, 25.0, 1.0 - variance);
    float momentumBoost = lerp(3.0, 5.0, variance);

    float2 newVel = (1.0 - dtLine * momentumBoost) * st.zw
                  + (lineLength * velocity - st.xy) * velocityDeltaBoost * dtLine;
    float2 newEndpoint = st.xy + dtLine * newVel;

    float widthBoost = clamp(2.5 * length(velocity), 0.0, 1.0);
    float widthV = widthBoost * widthBoost * (3.0 - widthBoost * 2.0);

    float3 target;
    if (lineB.w < 0.5)
    {
        // "Original": RGB straight from the velocity vector.
        target = float3(clamp(float2(1.0, 0.66) * (0.5 + velocity), 0.0, 1.0), 0.5);
    }
    else
    {
        target = wheelColor(atan2(velocity.x, velocity.y));
    }
    float3 colorVel = cv.xyz * (1.0 - 3.0 * dtLine) + (target - cw.rgb) * 90.0 * dtLine;
    float3 color = clamp(cw.rgb + dtLine * colorVel, 0.0, 1.0);

    PlaceOut o;
    o.endVel = float4(newEndpoint, newVel);
    o.colorWidth = float4(color, widthV);
    o.colorVel = float4(colorVel, widthV); // opacity = smoothstepped widthBoost (wgpu Flux)
    return o;
}

// ---- Line rendering (Flux line shaders) -----------------------------------------
// gTex0..2 = state textures.
struct LineVOut
{
    float4 position : SV_Position;
    float2 vtx : TEXCOORD0;
    float4 color : TEXCOORD1;
    float lineOffset : TEXCOORD2;
};

LineVOut line_vertex(uint vid : SV_VertexID, uint iid : SV_InstanceID)
{
    uint cols = (uint)gridA.x;
    uint u = iid % cols;
    uint v = iid / cols;
    float2 basepoint = float2(u, v) * gridA.zw;
    float2 endpoint = gTex0.Load(int3(int(u), int(v), 0)).xy;
    float4 cw = gTex1.Load(int3(int(u), int(v), 0));
    float opacity = gTex2.Load(int3(int(u), int(v), 0)).w;
    float aspect = gridB.w;
    float zoom = lineA.x;
    float lineWidth = lineA.z;
    float glow = lineB.z;

    // Quad template: x in {-0.5, 0.5}, y in {0, 1}.
    float cx = ((vid & 1u) == 0u) ? -0.5 : 0.5;
    float cy = (vid < 2u) ? 0.0 : 1.0;
    float2 xBasis = float2(-endpoint.y, endpoint.x);
    xBasis /= (length(xBasis) + 0.0001);
    // NOTE: `point` is RESERVED in HLSL — named `pt`.
    float2 pt = float2(aspect, 1.0) * zoom * (basepoint * 2.0 - 1.0)
              + endpoint * cy
              + lineWidth * cw.a * xBasis * cx;
    pt.x /= aspect;

    LineVOut o;
    o.position = float4(pt, 0.0, 1.0);
    o.vtx = float2(cx, cy);
    o.color = float4(cw.rgb * glow, opacity);
    float shortBoost = 1.0 + (lineWidth * cw.a) / (length(endpoint) + 1e-6);
    o.lineOffset = lineA.w / shortBoost;
    return o;
}

float4 line_fragment(LineVOut fsIn) : SV_Target
{
    float fade = smoothstep(fsIn.lineOffset, 1.0, fsIn.vtx.y);
    float xo = abs(fsIn.vtx.x);
    float edge = 1.0 - smoothstep(0.5 - fwidth(xo), 0.5, xo);
    return float4(fsIn.color.rgb, fsIn.color.a * fade * edge);
}

// ---- Endpoint rendering (Flux endpoint shaders) -----------------------------------
struct EndVOut
{
    float4 position : SV_Position;
    float2 vtx : TEXCOORD0;
    float2 midpointVec : TEXCOORD1;
    float4 topColor : TEXCOORD2;
    float4 bottomColor : TEXCOORD3;
};

EndVOut endpoint_vertex(uint vid : SV_VertexID, uint iid : SV_InstanceID)
{
    uint cols = (uint)gridA.x;
    uint u = iid % cols;
    uint v = iid / cols;
    float2 basepoint = float2(u, v) * gridA.zw;
    float2 endpoint = gTex0.Load(int3(int(u), int(v), 0)).xy;
    float4 cw = gTex1.Load(int3(int(u), int(v), 0));
    float opacity = gTex2.Load(int3(int(u), int(v), 0)).w;
    float aspect = gridB.w;
    float zoom = lineA.x;
    float lineWidth = lineA.z;
    float glow = lineB.z;

    // Quad corner in [-1,1]^2.
    float2 corner = float2(((vid & 1u) == 0u) ? -1.0 : 1.0, (vid < 2u) ? -1.0 : 1.0);
    float2 pt = float2(aspect, 1.0) * zoom * (basepoint * 2.0 - 1.0)
              + endpoint
              + 0.5 * lineWidth * cw.a * corner;
    pt.x /= aspect;

    EndVOut o;
    o.position = float4(pt, 0.0, 1.0);
    o.vtx = corner;
    o.midpointVec = float2(endpoint.y, -endpoint.x); // endpoint rotated 90 degrees
    float3 rgb = cw.rgb * glow;
    o.topColor = float4(rgb, 1.0);
    // Compensate for the line already drawn underneath (premultiplied reverse-blend).
    o.bottomColor = float4(rgb - rgb * opacity, 1.0);
    return o;
}

float4 endpoint_fragment(EndVOut fsIn) : SV_Target
{
    float4 color = fsIn.bottomColor;
    float side = (fsIn.vtx.x - fsIn.midpointVec.x) * (-fsIn.midpointVec.y)
               - (fsIn.vtx.y - fsIn.midpointVec.y) * (-fsIn.midpointVec.x);
    if (side > 0.0)
    {
        color = fsIn.topColor;
    }
    float dist = length(fsIn.vtx);
    float edge = 1.0 - smoothstep(1.0 - fwidth(dist), 1.0, dist);
    return float4(color.rgb, color.a * edge);
}

// ---- Final linear → sRGB encode (wgpu swapchain behavior) -------------------------
float3 srgbEncode(float3 c)
{
    c = clamp(c, 0.0, 1.0);
    float3 lo = 12.92 * c;
    float3 hi = 1.055 * pow(c, 1.0 / 2.4) - 0.055;
    return lerp(hi, lo, step(c, 0.0031308));
}

float4 encode_frag(FSOut fsIn) : SV_Target
{
    return float4(srgbEncode(gTex0.SampleLevel(samplerLinearClamp, fsIn.uv, 0.0).rgb), 1.0);
}
