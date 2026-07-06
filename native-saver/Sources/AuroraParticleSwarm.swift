import Metal
import simd

/// Native Metal port of the web `FlowingParticles.ts` scene — the "Particle Swarm":
/// 60,000 real GPU points, each advected through a two-octave curl-noise flow and
/// drawn as an additive soft disc. Unlike the 16 fullscreen-fragment scenes this
/// is a genuine point-primitive draw, so the renderer dispatches here for scene 17
/// (mirroring how Flux Drift gets its own multi-pass pipeline).
///
/// Seeds are generated with the SAME deterministic xorshift PRNG and formula as
/// the web build, so the point cloud is identical across web, macOS, and Windows.
final class AuroraParticleSwarm {
    static let MAX_PARTICLES = 60000
    static let sceneIndex: Float = 17

    // Matches the web ShaderMaterial uniforms + the CPU-built camera matrices.
    struct SwarmUniforms {
        var modelView = matrix_identity_float4x4
        var proj = matrix_identity_float4x4
        var time: Float = 0
        var speed: Float = 0.85
        var scale: Float = 1.0
        var size: Float = 3.4
        var colorA: SIMD4<Float> = .init(0, 0, 0, 1)
        var colorB: SIMD4<Float> = .init(0, 0, 0, 1)
        var pointScale: Float = 1.0  // drawable px / logical px, so points size with resolution
        var pad0: SIMD3<Float> = .init(0, 0, 0)
    }

    private let pipeline: MTLRenderPipelineState
    private let seedBuffer: MTLBuffer
    private var uniforms = SwarmUniforms()

    init?(device: MTLDevice, drawablePixelFormat: MTLPixelFormat) {
        do {
            let lib = try device.makeLibrary(source: AuroraParticleSwarm.metal, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "swarm_vertex")
            d.fragmentFunction = lib.makeFunction(name: "swarm_fragment")
            let att = d.colorAttachments[0]!
            att.pixelFormat = drawablePixelFormat
            att.isBlendingEnabled = true
            att.rgbBlendOperation = .add
            att.alphaBlendOperation = .add
            att.sourceRGBBlendFactor = .sourceAlpha
            att.destinationRGBBlendFactor = .one       // additive with source alpha (matches web)
            att.sourceAlphaBlendFactor = .one
            att.destinationAlphaBlendFactor = .one
            pipeline = try device.makeRenderPipelineState(descriptor: d)
        } catch {
            NSLog("[Aurora] Particle Swarm pipeline build failed: \(error)")
            return nil
        }

        // Build the seed buffer: (float3 seed, float rnd) per particle, with the
        // EXACT web PRNG so the cloud matches. Web: seed = (rand-0.5)*3, rnd = rand.
        var s: UInt32 = 0x2545f491
        func rand() -> Float {
            s ^= s << 13; s ^= s >> 17; s ^= s << 5
            return Float(s % 100000) / 100000
        }
        var data = [SIMD4<Float>](repeating: .init(0, 0, 0, 0), count: AuroraParticleSwarm.MAX_PARTICLES)
        for i in 0..<AuroraParticleSwarm.MAX_PARTICLES {
            let x = (rand() - 0.5) * 3.0
            let y = (rand() - 0.5) * 3.0
            let z = (rand() - 0.5) * 3.0
            let r = rand()
            data[i] = SIMD4<Float>(x, y, z, r)
        }
        guard let buf = device.makeBuffer(bytes: data,
                                          length: MemoryLayout<SIMD4<Float>>.stride * data.count,
                                          options: .storageModeShared) else { return nil }
        seedBuffer = buf
    }

    private static func perspective(fovYRadians: Float, aspect: Float, near: Float, far: Float) -> matrix_float4x4 {
        let f = 1.0 / tan(fovYRadians / 2.0)
        var m = matrix_float4x4()
        m.columns.0 = SIMD4<Float>(f / aspect, 0, 0, 0)
        m.columns.1 = SIMD4<Float>(0, f, 0, 0)
        m.columns.2 = SIMD4<Float>(0, 0, (far + near) / (near - far), -1)
        m.columns.3 = SIMD4<Float>(0, 0, 2 * far * near / (near - far), 0)
        return m
    }
    private static func rotateY(_ a: Float) -> matrix_float4x4 {
        let c = cos(a), s = sin(a)
        var m = matrix_identity_float4x4
        m.columns.0 = SIMD4<Float>(c, 0, -s, 0)
        m.columns.2 = SIMD4<Float>(s, 0, c, 0)
        return m
    }
    private static func translate(_ x: Float, _ y: Float, _ z: Float) -> matrix_float4x4 {
        var m = matrix_identity_float4x4
        m.columns.3 = SIMD4<Float>(x, y, z, 1)
        return m
    }

    /// Draw one frame of the swarm into `target`.
    func encode(into cmd: MTLCommandBuffer, target: MTLTexture, uniforms u: AuroraUniforms) {
        let aspect = u.resolution.x / max(u.resolution.y, 1)
        // Camera: PerspectiveCamera(fov 60, aspect, 0.1, 100) at (0,0,3.2). The web
        // rotates the mesh by RAW time (points.rotation.y = time*0.03) — NOT the
        // speed-scaled t — so the swirl and the spin are independent, like the web.
        let view = AuroraParticleSwarm.translate(0, 0, -3.2)
        let model = AuroraParticleSwarm.rotateY(u.time * 0.03)
        uniforms.modelView = matrix_multiply(view, model)
        uniforms.proj = AuroraParticleSwarm.perspective(fovYRadians: 60.0 * .pi / 180.0,
                                                        aspect: aspect, near: 0.1, far: 100.0)
        uniforms.time = u.time
        // Web maps the native knobs through the same remap helpers the web scene uses:
        //   speed → remapSpeed(0.85): shader t = time * (0.85*knob/0.3)
        //   size  → remapSize(3.4):   point size anchor
        //   density → draw count fraction; intensity inert; Style → palette .b/.c.
        uniforms.speed = 0.85 * (u.speed / 0.3)
        uniforms.scale = 1.0
        uniforms.size = 3.4 * (u.size / 0.85)
        uniforms.colorA = u.colorB
        uniforms.colorB = u.colorC
        // Point size is computed in device pixels (as WebGL does); normalize by the
        // drawable height so the cloud density/size reads the same at any resolution.
        uniforms.pointScale = max(u.resolution.y / 900.0, 0.4)

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0.008, green: 0.012, blue: 0.039, alpha: 1)
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pipeline)
        var un = uniforms
        enc.setVertexBuffer(seedBuffer, offset: 0, index: 0)
        enc.setVertexBytes(&un, length: MemoryLayout<SwarmUniforms>.stride, index: 1)
        enc.setFragmentBytes(&un, length: MemoryLayout<SwarmUniforms>.stride, index: 1)
        // Web density maps directly to the visible fraction of points.
        let count = max(1, Int(Float(AuroraParticleSwarm.MAX_PARTICLES) * min(max(u.density, 0), 1)))
        enc.drawPrimitives(type: .point, vertexStart: 0, vertexCount: count)
        enc.endEncoding()
    }
}

extension AuroraParticleSwarm {
    /// Point-primitive MSL. Vertex advects each seed by two-octave curl noise and
    /// projects it; fragment draws a soft additive disc. 1:1 with FlowingParticles.ts.
    static let metal = """
    #include <metal_stdlib>
    using namespace metal;

    struct SwarmUniforms {
        float4x4 modelView;
        float4x4 proj;
        float time; float speed; float scale; float size;
        float4 colorA; float4 colorB;
        float pointScale; float3 pad0;
    };

    // ---- 3D simplex noise + curl (matches the web SIMPLEX_3D + CURL_NOISE) -------
    static float3 mod289(float3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    static float4 mod289(float4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    static float4 permute(float4 x){ return mod289(((x*34.0)+1.0)*x); }
    static float4 taylorInvSqrt(float4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
    static float snoise3(float3 v){
        const float2 C = float2(1.0/6.0, 1.0/3.0);
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
        float4 p = permute(permute(permute(i.z + float4(0.0, i1.z, i2.z, 1.0))
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
        float3 g0 = float3(a0.xy, h.x);
        float3 g1 = float3(a0.zw, h.y);
        float3 g2 = float3(a1.xy, h.z);
        float3 g3 = float3(a1.zw, h.w);
        float4 norm = taylorInvSqrt(float4(dot(g0,g0), dot(g1,g1), dot(g2,g2), dot(g3,g3)));
        g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
        float4 m = max(0.6 - float4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m*m, float4(dot(g0,x0), dot(g1,x1), dot(g2,x2), dot(g3,x3)));
    }
    // curlNoise: curl of the simplex field, via finite differences (matches CURL_NOISE).
    static float3 curlNoise(float3 p){
        const float e = 0.1;
        float3 dx = float3(e, 0.0, 0.0);
        float3 dy = float3(0.0, e, 0.0);
        float3 dz = float3(0.0, 0.0, e);
        float3 p_x0 = float3(snoise3(p - dx), snoise3(p - dx + float3(31.4)), snoise3(p - dx + float3(57.7)));
        float3 p_x1 = float3(snoise3(p + dx), snoise3(p + dx + float3(31.4)), snoise3(p + dx + float3(57.7)));
        float3 p_y0 = float3(snoise3(p - dy), snoise3(p - dy + float3(31.4)), snoise3(p - dy + float3(57.7)));
        float3 p_y1 = float3(snoise3(p + dy), snoise3(p + dy + float3(31.4)), snoise3(p + dy + float3(57.7)));
        float3 p_z0 = float3(snoise3(p - dz), snoise3(p - dz + float3(31.4)), snoise3(p - dz + float3(57.7)));
        float3 p_z1 = float3(snoise3(p + dz), snoise3(p + dz + float3(31.4)), snoise3(p + dz + float3(57.7)));
        float x = (p_y1.z - p_y0.z) - (p_z1.y - p_z0.y);
        float y = (p_z1.x - p_z0.x) - (p_x1.z - p_x0.z);
        float z = (p_x1.y - p_x0.y) - (p_y1.x - p_y0.x);
        return normalize(float3(x, y, z) / (2.0 * e) + 1e-6);
    }

    struct VOut { float4 position [[position]]; float pointSize [[point_size]]; float glow; float3 color; };

    vertex VOut swarm_vertex(uint vid [[vertex_id]],
                             const device float4* seeds [[buffer(0)]],
                             constant SwarmUniforms& u [[buffer(1)]]) {
        float4 sd = seeds[vid];
        float3 seed = sd.xyz; float rnd = sd.w;
        float t = u.time * u.speed;
        float3 flow = curlNoise(seed * u.scale + float3(0.0, 0.0, t * 0.15));
        flow += 0.5 * curlNoise(seed * u.scale * 2.3 + float3(t * 0.1, 5.0, 0.0));
        float3 pos = seed + flow * 0.6 + float3(0.0, sin(t * 0.2 + rnd * 6.28) * 0.1, 0.0);
        float4 mv = u.modelView * float4(pos, 1.0);
        VOut o;
        o.position = u.proj * mv;
        o.pointSize = u.size * (1.0 + rnd) * (3.0 / max(-mv.z, 0.1)) * u.pointScale;
        o.glow = 0.4 + 0.6 * rnd;
        o.color = mix(u.colorA.rgb, u.colorB.rgb, clamp(length(flow) * 0.8, 0.0, 1.0));
        return o;
    }
    fragment float4 swarm_fragment(VOut in [[stage_in]], float2 pc [[point_coord]]) {
        float d = length(pc - 0.5);
        float core = smoothstep(0.5, 0.0, d);
        float halo = smoothstep(0.5, 0.15, d);
        float a = core * core;
        // RGB is NOT pre-multiplied by alpha — the SRC_ALPHA blend applies it once,
        // matching the web (screen += RGB * core²). Multiplying here too gave core⁴.
        return float4(in.color * in.glow * (1.6 * core + 0.5 * halo), a);
    }
    """
}
