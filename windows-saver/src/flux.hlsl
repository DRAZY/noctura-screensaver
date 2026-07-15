// 1:1 port of AuroraFluxFluid.swift's Metal MSL, compiled at runtime via D3DCompile.
// Entry points: fs_vertex, noise_frag, advect_frag, adjust_frag, diffuse_frag,
// inject_frag, divergence_frag, pressure_frag, subtract_frag, spring_frag,
// line_vertex, line_fragment.

SamplerState samplerLinearClamp : register(s0);

static const float2 FLUID_SIZE = float2(128.0, 128.0);

cbuffer FluidParams : register(b1)
{
    float amount;
    float dissipation;
    float alpha;
    float rBeta;
    float deltaTime;
    float pad0;
    float2 texel;
    float4 chScale;
    float4 chMult;
    float4 chOffset;
};

cbuffer LineParams : register(b2)
{
    float2 gridSize;
    float aspect;
    float zoom;
    float lineLength;
    float lineVariance;
    float velGain;
    float lineDeltaTime;  // renamed from MSL `deltaTime`: HLSL cbuffer members are
                          // global-scope, so it cannot collide with FluidParams.deltaTime.
                          // Same 32-bit slot/offset, so the Rust repr(C) layout is unchanged.
    float lineWidth;
    float beginOffset;
    float glow;
    float time;
    uint numLines;
    uint gx;
    float4 colorA;
    float4 colorB;
    float4 colorC;
};

Texture2D<float4> gTexA : register(t0);
Texture2D<float4> gTexB : register(t1);
Texture2D<float4> gTexC : register(t2);

struct FSOut
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

struct LineVOut
{
    float4 position : SV_Position;
    float2 vtx : TEXCOORD0;
    float3 color : TEXCOORD1;
    float alpha : TEXCOORD2;
    float beginOffset : TEXCOORD3;
};

float3 mod289(float3 x)
{
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

float4 mod289(float4 x)
{
    return x - floor(x * (1.0 / 289.0)) * 289.0;
}

float4 permute(float4 x)
{
    return mod289(((x * 34.0) + 1.0) * x);
}

float4 taylorInvSqrt(float4 r)
{
    return 1.79284291400159 - 0.85373472095314 * r;
}

float snoise3(float3 v)
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
    float4 p = permute(
        permute(
            permute(i.z + float4(0.0, i1.z, i2.z, 1.0)) +
            i.y + float4(0.0, i1.y, i2.y, 1.0)) +
        i.x + float4(0.0, i1.x, i2.x, 1.0));
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
    g0 *= norm.x;
    g1 *= norm.y;
    g2 *= norm.z;
    g3 *= norm.w;
    float4 m = max(0.6 - float4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    m = m * m;
    float4 px = float4(dot(x0, g0), dot(x1, g1), dot(x2, g2), dot(x3, g3));
    return 42.0 * dot(m, px);
}

float2 makePair(float3 p)
{
    return float2(snoise3(p), snoise3(p + float3(8.0, -8.0, 0.0)));
}

float hashf(float2 pp)
{
    pp = frac(pp * float2(123.34, 456.21));
    pp += dot(pp, pp + 45.32);
    return frac(pp.x * pp.y);
}

float3 palCyc(float x)
{
    float f = frac(x);
    if (f < 0.3333)
    {
        return lerp(colorA.rgb, colorB.rgb, f / 0.3333);
    }
    if (f < 0.6666)
    {
        return lerp(colorB.rgb, colorC.rgb, (f - 0.3333) / 0.3333);
    }
    return lerp(colorC.rgb, colorA.rgb, (f - 0.6666) / 0.3334);
}

FSOut fs_vertex(uint vid : SV_VertexID)
{
    float2 v[3] = {
        float2(-1.0, -1.0),
        float2(3.0, -1.0),
        float2(-1.0, 3.0)
    };

    FSOut o;
    float2 p = v[vid];
    o.position = float4(p, 0.0, 1.0);
    o.uv = p * 0.5 + 0.5;
    return o;
}

float4 noise_frag(FSOut input) : SV_Target
{
    float2 uv = input.uv;
    float2 n =
        chMult.x * makePair(float3(chScale.x * uv, chOffset.x)) +
        chMult.y * makePair(float3(chScale.y * uv, chOffset.y)) +
        chMult.z * makePair(float3(chScale.z * uv, chOffset.z));
    return float4(n * 0.45, 0.0, 1.0);
}

float4 advect_frag(FSOut input) : SV_Target
{
    float2 tp = floor(FLUID_SIZE * input.uv);
    float2 v = gTexA.Load(int3(int(tp.x), int(tp.y), 0)).xy;
    float2 adv = ((tp + 0.5) - amount * v) / FLUID_SIZE;
    float decay = 1.0 + dissipation * amount;
    return float4(gTexA.Sample(samplerLinearClamp, adv).xy / decay, 0.0, 1.0);
}

float4 adjust_frag(FSOut input) : SV_Target
{
    uint2 pos = uint2(floor(input.uv * FLUID_SIZE));
    float2 v = gTexA.Load(int3(int(pos.x), int(pos.y), 0)).xy;
    float2 sp = (0.5 + floor((float2(pos) + 1.0) - deltaTime * v)) / FLUID_SIZE;
    float2 t = texel;
    float2 L = gTexA.Sample(samplerLinearClamp, sp + float2(-t.x, 0.0)).xy;
    float2 R = gTexA.Sample(samplerLinearClamp, sp + float2(t.x, 0.0)).xy;
    float2 T = gTexA.Sample(samplerLinearClamp, sp + float2(0.0, t.y)).xy;
    float2 B = gTexA.Sample(samplerLinearClamp, sp + float2(0.0, -t.y)).xy;
    float2 lo = min(L, min(R, min(T, B)));
    float2 hi = max(L, max(R, max(T, B)));
    float2 adjusted = gTexB.Load(int3(int(pos.x), int(pos.y), 0)).xy + 0.5 * (v - gTexC.Load(int3(int(pos.x), int(pos.y), 0)).xy);
    return float4(clamp(adjusted, lo, hi), 0.0, 1.0);
}

float4 diffuse_frag(FSOut input) : SV_Target
{
    float2 uv = input.uv;
    float2 t = texel;
    float2 c = gTexA.Load(int3(int(floor(FLUID_SIZE.x * uv.x)), int(floor(FLUID_SIZE.y * uv.y)), 0)).xy;
    float2 L = gTexA.Sample(samplerLinearClamp, uv + float2(-t.x, 0.0)).xy;
    float2 R = gTexA.Sample(samplerLinearClamp, uv + float2(t.x, 0.0)).xy;
    float2 T = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, t.y)).xy;
    float2 B = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, -t.y)).xy;
    return float4(rBeta * (L + R + B + T + alpha * c), 0.0, 1.0);
}

float4 inject_frag(FSOut input) : SV_Target
{
    float2 v = gTexA.Sample(samplerLinearClamp, input.uv).xy;
    float2 n = gTexB.Sample(samplerLinearClamp, input.uv).xy;
    return float4(v + deltaTime * n, 0.0, 1.0);
}

float4 divergence_frag(FSOut input) : SV_Target
{
    float2 uv = input.uv;
    float2 t = texel;
    float L = gTexA.Sample(samplerLinearClamp, uv + float2(-t.x, 0.0)).x;
    float R = gTexA.Sample(samplerLinearClamp, uv + float2(t.x, 0.0)).x;
    float T = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, t.y)).y;
    float B = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, -t.y)).y;
    return float4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
}

float4 pressure_frag(FSOut input) : SV_Target
{
    float2 uv = input.uv;
    float2 t = texel;
    float d = gTexB.Load(int3(int(floor(FLUID_SIZE.x * uv.x)), int(floor(FLUID_SIZE.y * uv.y)), 0)).x;
    float L = gTexA.Sample(samplerLinearClamp, uv + float2(-t.x, 0.0)).x;
    float R = gTexA.Sample(samplerLinearClamp, uv + float2(t.x, 0.0)).x;
    float T = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, t.y)).x;
    float B = gTexA.Sample(samplerLinearClamp, uv + float2(0.0, -t.y)).x;
    return float4(rBeta * (L + R + B + T + alpha * d), 0.0, 0.0, 1.0);
}

float4 subtract_frag(FSOut input) : SV_Target
{
    float2 uv = input.uv;
    float2 t = texel;
    float L = gTexB.Sample(samplerLinearClamp, uv + float2(-t.x, 0.0)).x;
    float R = gTexB.Sample(samplerLinearClamp, uv + float2(t.x, 0.0)).x;
    float T = gTexB.Sample(samplerLinearClamp, uv + float2(0.0, t.y)).x;
    float B = gTexB.Sample(samplerLinearClamp, uv + float2(0.0, -t.y)).x;
    float2 v = gTexA.Load(int3(int(floor(FLUID_SIZE.x * uv.x)), int(floor(FLUID_SIZE.y * uv.y)), 0)).xy;
    float2 boundary = float2(1.0, 1.0);
    if (uv.x < t.x || uv.x > 1.0 - t.x)
    {
        boundary.x = 0.0;
    }
    if (uv.y < t.y || uv.y > 1.0 - t.y)
    {
        boundary.y = 0.0;
    }
    return float4(boundary * (v - 0.5 * float2(R - L, T - B)), 0.0, 1.0);
}

float4 spring_frag(FSOut input) : SV_Target
{
    uint2 tc = uint2(input.position.xy);
    float2 grid = float2(tc);
    float2 basepoint = (grid + 0.5) / gridSize;
    float2 velocity = gTexA.Sample(samplerLinearClamp, basepoint).xy * velGain;
    float4 st = gTexB.Load(int3(int(tc.x), int(tc.y), 0));
    float2 endpoint = st.xy;
    float2 springVel = st.zw;
    float variance = lerp(1.0 - lineVariance, 1.0, hashf(grid));
    float vdb = lerp(3.0, 25.0, 1.0 - variance);
    float mb = lerp(3.0, 5.0, variance);
    float2 newVel = (1.0 - lineDeltaTime * mb) * springVel + (lineLength * velocity - endpoint) * vdb * lineDeltaTime;
    float2 newEndpoint = endpoint + lineDeltaTime * newVel;
    float len = length(newEndpoint);
    if (len > 0.6)
    {
        newEndpoint *= 0.6 / len;
    }
    return float4(newEndpoint, newVel);
}

LineVOut line_vertex(uint vid : SV_VertexID, uint iid : SV_InstanceID)
{
    uint cell = (iid * 7001u) % numLines;
    uint cellX = cell % gx;
    uint cellY = cell / gx;
    float2 grid = float2(cellX, cellY);
    float2 basepoint = (grid + 0.5) / gridSize;
    float2 endpoint = gTexA.Load(int3(int(cellX), int(cellY), 0)).xy;
    float2 fluidVel = gTexB.SampleLevel(samplerLinearClamp, basepoint, 0.0).xy * velGain;
    float wb = clamp(2.5 * length(fluidVel), 0.0, 1.0);
    float lineWidthWeight = wb * wb * (3.0 - 2.0 * wb);
    float cx = ((vid & 1u) == 0u) ? -0.5 : 0.5;
    float cy = (vid < 2u) ? 0.0 : 1.0;
    float2 xBasis = float2(-endpoint.y, endpoint.x);
    xBasis /= (length(xBasis) + 1e-4);
    // NOTE: `point` is a RESERVED KEYWORD in HLSL (GS primitive modifier) — FXC
    // rejects it as an identifier even though MSL/GLSL allow it. Named `pt` here.
    float2 pt = float2(aspect, 1.0) * zoom * (basepoint * 2.0 - 1.0) + endpoint * cy + lineWidth * lineWidthWeight * xBasis * cx;
    pt.x /= aspect;

    LineVOut o;
    o.position = float4(pt, 0.0, 1.0);
    o.vtx = float2(cx, cy);
    float shortBoost = 1.0 + (lineWidth * lineWidthWeight) / (length(endpoint) + 1e-4);
    o.beginOffset = beginOffset / shortBoost;
    float angle = atan2(fluidVel.y, fluidVel.x) / 6.28318 + 0.5;
    o.color = palCyc(angle + 0.35 * (basepoint.x + basepoint.y) + 0.01 * time);
    o.alpha = wb;
    return o;
}

float4 line_fragment(LineVOut input) : SV_Target
{
    float fade = smoothstep(input.beginOffset, 1.0, input.vtx.y);
    float xo = abs(input.vtx.x);
    float edge = 1.0 - smoothstep(0.5 - fwidth(xo), 0.5, xo);
    float a = input.alpha * fade * edge;
    if (a <= 0.0009)
    {
        discard;
    }
    return float4(input.color * a * glow, 1.0);
}
