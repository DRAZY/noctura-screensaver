Buffer<float4> gSeeds : register(t0);

cbuffer SwarmParams : register(b1)
{
    column_major float4x4 modelView;
    column_major float4x4 proj;
    float time;
    float speed;
    float scale;
    float size;
    float4 colorA;
    float4 colorB;
    float pointScale;
    float2 resolution;  // render viewport (back-buffer) size in pixels
    float pad0;
};

struct SwarmVOut
{
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
    float glow : TEXCOORD1;
    float3 color : TEXCOORD2;
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
    const float4 D = float4(0.0, 0.5, 1.0, 2.0);
    float3 i = floor(v + dot(v, C.yyy));
    float3 x0 = v - i + dot(i, C.xxx);
    float3 g = step(x0.yzx, x0.xyz);
    float3 l = 1.0 - g;
    float3 i1 = min(g.xyz, l.zxy);
    float3 i2 = max(g.xyz, l.zxy);
    float3 x1 = x0 - i1 + C.xxx;
    float3 x2 = x0 - i2 + C.yyy;
    float3 x3 = x0 - D.yyy;
    i = mod289(i);
    float4 p = permute(
        permute(
            permute(i.z + float4(0.0, i1.z, i2.z, 1.0)) +
            i.y + float4(0.0, i1.y, i2.y, 1.0)) +
        i.x + float4(0.0, i1.x, i2.x, 1.0));
    const float n_ = 0.142857142857;
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
    return 42.0 * dot(m * m, float4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)));
}

float3 curlNoise(float3 p)
{
    const float e = 0.1;
    float3 dx = float3(e, 0.0, 0.0);
    float3 dy = float3(0.0, e, 0.0);
    float3 dz = float3(0.0, 0.0, e);
    float3 p_x0 = float3(snoise3(p - dx), snoise3(p - dx + float3(31.4, 31.4, 31.4)), snoise3(p - dx + float3(57.7, 57.7, 57.7)));
    float3 p_x1 = float3(snoise3(p + dx), snoise3(p + dx + float3(31.4, 31.4, 31.4)), snoise3(p + dx + float3(57.7, 57.7, 57.7)));
    float3 p_y0 = float3(snoise3(p - dy), snoise3(p - dy + float3(31.4, 31.4, 31.4)), snoise3(p - dy + float3(57.7, 57.7, 57.7)));
    float3 p_y1 = float3(snoise3(p + dy), snoise3(p + dy + float3(31.4, 31.4, 31.4)), snoise3(p + dy + float3(57.7, 57.7, 57.7)));
    float3 p_z0 = float3(snoise3(p - dz), snoise3(p - dz + float3(31.4, 31.4, 31.4)), snoise3(p - dz + float3(57.7, 57.7, 57.7)));
    float3 p_z1 = float3(snoise3(p + dz), snoise3(p + dz + float3(31.4, 31.4, 31.4)), snoise3(p + dz + float3(57.7, 57.7, 57.7)));
    float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
    float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
    float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);
    return normalize(float3(x, y, z) / (2.0 * e) + 1e-6);
}

SwarmVOut swarm_vertex(uint vid : SV_VertexID, uint iid : SV_InstanceID)
{
    float4 sd = gSeeds[iid];
    float3 seed = sd.xyz;
    float rnd = sd.w;
    float t = time * speed;
    float3 flow = curlNoise(seed * scale + float3(0.0, 0.0, t * 0.15));
    flow += 0.5 * curlNoise(seed * scale * 2.3 + float3(t * 0.1, 5.0, 0.0));
    float3 pos = seed + flow * 0.6 + float3(0.0, sin(t * 0.2 + rnd * 6.28) * 0.1, 0.0);
    float4 mv = mul(modelView, float4(pos, 1.0));
    // `clip` shadows the HLSL clip() intrinsic — renamed defensively for FXC.
    float4 clipPos = mul(proj, mv);
    // gl_PointSize (device pixels) from the Metal reference. Convert to an NDC
    // half-extent: NDC spans 2.0 across `resolution` px, and pointPx is the full
    // sprite diameter, so half-extent = (pointPx / 2) * (2 / resPx) = pointPx / resPx.
    float pointPx = size * (1.0 + rnd) * (3.0 / max(-mv.z, 0.1)) * pointScale;
    float2 ndcHalf = float2(pointPx / resolution.x, pointPx / resolution.y);
    // 4-vertex triangle strip → quad corners (0,0),(1,0),(0,1),(1,1); sign in {-1,+1}.
    float2 uv = float2((vid & 1u) ? 1.0 : 0.0, (vid < 2u) ? 0.0 : 1.0);
    float2 sgn = uv * 2.0 - 1.0;

    SwarmVOut o;
    clipPos.xy += sgn * ndcHalf * clipPos.w;  // offset before perspective divide
    o.position = clipPos;
    o.uv = uv;
    o.glow = 0.4 + 0.6 * rnd;
    o.color = lerp(colorA.rgb, colorB.rgb, clamp(length(flow) * 0.8, 0.0, 1.0));
    return o;
}

float4 swarm_fragment(SwarmVOut input) : SV_Target
{
    float d = length(input.uv - 0.5);
    float core = smoothstep(0.5, 0.0, d);
    float halo = smoothstep(0.5, 0.15, d);
    float a = core * core;
    // RGB is NOT pre-multiplied by alpha — the SRC_ALPHA blend applies it once,
    // matching the web (screen += RGB * core²). Multiplying here too gave core⁴.
    return float4(input.color * input.glow * (1.6 * core + 0.5 * halo), a);
}
