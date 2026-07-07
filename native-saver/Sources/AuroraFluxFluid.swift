import Metal
import QuartzCore
import simd

/// Native Metal port of the web `FluxFluid.ts` + the Flux Drift line springs
/// (`src/scenes/Drift.ts`). A real 128² Jos-Stam "Stable Fluids" simulation runs
/// as a chain of fullscreen render passes into float textures, a spring pass
/// advances one endpoint per line into a state texture, and instanced quads draw
/// the luminous blades — the exact same algorithm and constants as the web build,
/// so all three renderers match.
///
/// This is multi-pass, unlike the single-fullscreen-fragment path the other 16
/// scenes use; the renderer dispatches here only for Flux Drift (scene 16). If it
/// fails to build, the renderer falls back to the per-pixel `sceneDrift` shader.
final class AuroraFluxFluid {
    // Matches the web Drift.ts constants exactly (source of truth for parity).
    static let GX = 128, GY = 72
    static let NUM_LINES = GX * GY               // 9216
    static let FLUID = 128                        // fluid grid (square, like Flux fluid_size)
    static let TIME_SCALE: Float = 0.115
    static let VEL_GAIN: Float = 10.0
    static let DISSIPATION: Float = 2.0
    static let BASE_LINE_LENGTH: Float = 0.6
    static let VISCOSITY: Float = 5.0
    static let DIFFUSE_ITERS = 3
    static let PRESSURE_ITERS = 19

    // CPU-side mirrors of the MSL param structs (field order/padding must match).
    struct FluidParams {
        var amount: Float = 0, dissipation: Float = 0, alpha: Float = 0, rBeta: Float = 0
        var deltaTime: Float = 0, pad0: Float = 0
        var texel: SIMD2<Float> = .init(0, 0)
        var chScale: SIMD4<Float> = .init(0, 0, 0, 0)
        var chMult: SIMD4<Float> = .init(0, 0, 0, 0)
        var chOffset: SIMD4<Float> = .init(0, 0, 0, 0)
    }
    struct LineParams {
        var gridSize: SIMD2<Float> = .init(Float(GX), Float(GY))
        var aspect: Float = 1, zoom: Float = 1.6
        var lineLength: Float = BASE_LINE_LENGTH, lineVariance: Float = 0.45
        var velGain: Float = VEL_GAIN, deltaTime: Float = 1.0 / 60
        var lineWidth: Float = 0.011, beginOffset: Float = 0.4, glow: Float = 2.0, time: Float = 0
        var numLines: UInt32 = UInt32(NUM_LINES), gx: UInt32 = UInt32(GX)
        var colorA: SIMD4<Float> = .init(0, 0, 0, 1)
        var colorB: SIMD4<Float> = .init(0, 0, 0, 1)
        var colorC: SIMD4<Float> = .init(0, 0, 0, 1)
    }

    private let device: MTLDevice
    private let drawablePixelFormat: MTLPixelFormat

    // Fluid textures (ping-ponged). rg = velocity/noise, r = pressure/divergence.
    private var velA, velB, prsA, prsB, divT, noiseT, fwdT, revT: MTLTexture!
    // Line state: (endpoint.xy, springVel.zw), GX×GY.
    private var stateA, stateB: MTLTexture!

    // Pipelines — one fragment per fluid pass, plus spring + line.
    private var pNoise, pAdvect, pAdjust, pDiffuse, pInject, pDivergence, pPressure, pSubtract: MTLRenderPipelineState!
    private var pSpring: MTLRenderPipelineState!
    private var pLine: MTLRenderPipelineState!

    private var lineParams = LineParams()
    private var simTime: Float = 0
    private var lastTime: Float = -1
    private var accumulator: Float = 0
    private var warmupLeft: Int = 150   // fluid warm-up steps remaining (amortized across frames)
    private var cleared = false          // whether the sim textures were zero-cleared once

    init?(device: MTLDevice, drawablePixelFormat: MTLPixelFormat) {
        self.device = device
        self.drawablePixelFormat = drawablePixelFormat
        do {
            let lib = try device.makeLibrary(source: AuroraFluxFluid.metal, options: nil)
            func frag(_ name: String, _ fmt: MTLPixelFormat, blend: Bool = false, vfn: String = "fs_vertex") throws -> MTLRenderPipelineState {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = lib.makeFunction(name: vfn)
                d.fragmentFunction = lib.makeFunction(name: name)
                d.colorAttachments[0].pixelFormat = fmt
                if blend {
                    d.colorAttachments[0].isBlendingEnabled = true
                    d.colorAttachments[0].rgbBlendOperation = .add
                    d.colorAttachments[0].alphaBlendOperation = .add
                    d.colorAttachments[0].sourceRGBBlendFactor = .one
                    d.colorAttachments[0].destinationRGBBlendFactor = .one
                    d.colorAttachments[0].sourceAlphaBlendFactor = .one
                    d.colorAttachments[0].destinationAlphaBlendFactor = .one
                }
                return try device.makeRenderPipelineState(descriptor: d)
            }
            let rg = MTLPixelFormat.rg32Float, r = MTLPixelFormat.r32Float, rgba = MTLPixelFormat.rgba32Float
            pNoise = try frag("noise_frag", rg)
            pAdvect = try frag("advect_frag", rg)
            pAdjust = try frag("adjust_frag", rg)
            pDiffuse = try frag("diffuse_frag", rg)
            pInject = try frag("inject_frag", rg)
            pDivergence = try frag("divergence_frag", r)
            pPressure = try frag("pressure_frag", r)
            pSubtract = try frag("subtract_frag", rg)
            pSpring = try frag("spring_frag", rgba)
            let ld = MTLRenderPipelineDescriptor()
            ld.vertexFunction = lib.makeFunction(name: "line_vertex")
            ld.fragmentFunction = lib.makeFunction(name: "line_fragment")
            ld.colorAttachments[0].pixelFormat = drawablePixelFormat
            ld.colorAttachments[0].isBlendingEnabled = true
            ld.colorAttachments[0].rgbBlendOperation = .add
            ld.colorAttachments[0].sourceRGBBlendFactor = .one
            ld.colorAttachments[0].destinationRGBBlendFactor = .one
            pLine = try device.makeRenderPipelineState(descriptor: ld)
        } catch {
            NSLog("[Aurora] Flux fluid pipeline build failed: \(error)")
            return nil
        }
        guard makeTextures() else { return nil }
    }

    private func tex(_ w: Int, _ h: Int, _ fmt: MTLPixelFormat) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: fmt, width: w, height: h, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        return device.makeTexture(descriptor: d)
    }

    private func makeTextures() -> Bool {
        let n = AuroraFluxFluid.FLUID
        guard let a = tex(n, n, .rg32Float), let b = tex(n, n, .rg32Float),
              let pa = tex(n, n, .r32Float), let pb = tex(n, n, .r32Float),
              let dv = tex(n, n, .r32Float), let no = tex(n, n, .rg32Float),
              let fw = tex(n, n, .rg32Float), let rv = tex(n, n, .rg32Float),
              let sa = tex(AuroraFluxFluid.GX, AuroraFluxFluid.GY, .rgba32Float),
              let sb = tex(AuroraFluxFluid.GX, AuroraFluxFluid.GY, .rgba32Float) else { return false }
        velA = a; velB = b; prsA = pa; prsB = pb; divT = dv; noiseT = no; fwdT = fw; revT = rv
        stateA = sa; stateB = sb
        return true
    }

    /// Draw one fluid-driven frame of Flux Drift into `target` (a drawable's
    /// texture in the live saver, or an offscreen texture in the headless harness).
    func encode(into cmd: MTLCommandBuffer, target: MTLTexture, uniforms u: AuroraUniforms) {
        // Fixed-timestep accumulator (mirrors web update()). dt derived from scene time.
        let now = u.time
        let realDelta: Float = (lastTime < 0) ? (1.0 / 60) : max(0, min(now - lastTime, 0.25))
        lastTime = now
        let speedScale = u.speed / 0.3
        let step: Float = 1.0 / 60

        // Configure per-scene controls (Size → fluid energy + line length; Intensity → glow; Style → palette).
        let noiseMult = 0.75 + 0.30 * (u.size - 0.85) / 0.85
        lineParams.colorA = u.colorA; lineParams.colorB = u.colorB; lineParams.colorC = u.colorC
        lineParams.glow = 1.0 + u.intensity
        lineParams.aspect = u.resolution.x / max(u.resolution.y, 1)
        lineParams.lineLength = AuroraFluxFluid.BASE_LINE_LENGTH * (1.0 + 0.5 * (u.size - 0.85))
        lineParams.velGain = AuroraFluxFluid.VEL_GAIN
        lineParams.time = simTime

        // Metal .private textures start with UNDEFINED contents; the sim assumes
        // velocity/pressure/state all begin at zero (like a freshly-cleared WebGL
        // render target). Clear them once, or the field is garbage/NaN.
        if !cleared {
            cleared = true
            for t in [velA, velB, prsA, prsB, divT, noiseT, fwdT, revT, stateA, stateB] { clearZero(cmd, t) }
        }
        // Amortized warm-up: run a bounded number of fluid steps per frame instead of
        // a 150-step burst on frame one. A burst is ~150×29 ≈ 4350 draws in a single
        // frame — a multi-second stall on slower GPUs (and on Windows it can trip the
        // 2 s TDR watchdog). At 8/frame the field develops in ~19 frames (~0.3 s) with
        // no stall. Kept identical to the Windows renderer for cross-platform parity.
        if warmupLeft > 0 {
            let n = min(warmupLeft, 8)
            for _ in 0..<n { simTime += step; fluidStep(cmd, dt: step, noiseMult: Float(noiseMult)) }
            lineParams.time = simTime
            springStep(cmd, dt: step)   // settle the blades alongside the developing fluid
            warmupLeft -= n
        }

        // Advance sim in fixed 1/60 chunks scaled by TIME_SCALE (deterministic, fps-independent).
        accumulator += realDelta * AuroraFluxFluid.TIME_SCALE * speedScale
        var steps = 0
        while accumulator >= step && steps < 4 {
            simTime += step
            if simTime > 1000 { simTime -= 1000 }
            fluidStep(cmd, dt: step, noiseMult: Float(noiseMult))
            springStep(cmd, dt: step)
            accumulator -= step
            steps += 1
        }
        if accumulator > step { accumulator = step }
        lineParams.time = simTime

        // Final pass: draw the blades into the drawable.
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0.02, green: 0.016, blue: 0.047, alpha: 1)
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pLine)
        var lp = lineParams
        enc.setVertexBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        enc.setFragmentBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        enc.setVertexTexture(stateA, index: 0)
        enc.setVertexTexture(velA, index: 1)
        let drawCount = max(1, Int(Float(AuroraFluxFluid.NUM_LINES) * (0.65 + 0.35 * u.density)))
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: drawCount)
        enc.endEncoding()
    }

    /// Clear a texture to zero via an empty clear-load render pass.
    private func clearZero(_ cmd: MTLCommandBuffer, _ t: MTLTexture!) {
        guard let t = t else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = t
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        cmd.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
    }

    private func blit(_ cmd: MTLCommandBuffer, _ pipe: MTLRenderPipelineState, to target: MTLTexture,
                      params: inout FluidParams, textures: [MTLTexture?]) {
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = target
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pipe)
        enc.setFragmentBytes(&params, length: MemoryLayout<FluidParams>.stride, index: 0)
        for (i, t) in textures.enumerated() { enc.setFragmentTexture(t, index: i) }
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }

    private func fluidStep(_ cmd: MTLCommandBuffer, dt: Float, noiseMult: Float) {
        let texel = SIMD2<Float>(1.0 / Float(AuroraFluxFluid.FLUID), 1.0 / Float(AuroraFluxFluid.FLUID))
        var p = FluidParams(); p.texel = texel; p.deltaTime = dt

        // 1. Noise force field — offsets scroll at Flux's fixed increments, amplitude scales with Size.
        p.chScale = .init(2.5, 15.0, 30.0, 0)
        p.chMult = .init(1.0 * noiseMult, 0.7 * noiseMult, 0.5 * noiseMult, 0)
        p.chOffset = .init(0.0015 * simTime * 60, 0.009 * simTime * 60, 0.018 * simTime * 60, 0)
        blit(cmd, pNoise, to: noiseT, params: &p, textures: [])

        // 2. MacCormack advection: forward, reverse, adjust.
        p.dissipation = AuroraFluxFluid.DISSIPATION
        p.amount = dt;  blit(cmd, pAdvect, to: fwdT, params: &p, textures: [velA])
        p.amount = -dt; blit(cmd, pAdvect, to: revT, params: &p, textures: [velA])
        blit(cmd, pAdjust, to: velB, params: &p, textures: [velA, fwdT, revT]); swap(&velA, &velB)

        // 3. Diffuse (viscosity Jacobi).
        let center = 1.0 / (AuroraFluxFluid.VISCOSITY * dt)
        p.alpha = center; p.rBeta = 1.0 / (4.0 + center)
        for _ in 0..<AuroraFluxFluid.DIFFUSE_ITERS {
            blit(cmd, pDiffuse, to: velB, params: &p, textures: [velA]); swap(&velA, &velB)
        }

        // 4. Inject noise as a force.
        blit(cmd, pInject, to: velB, params: &p, textures: [velA, noiseT]); swap(&velA, &velB)

        // 5. Divergence.
        blit(cmd, pDivergence, to: divT, params: &p, textures: [velA])

        // 6. Pressure Jacobi (retain — reuse prior pressure as the initial guess).
        p.alpha = -1; p.rBeta = 0.25
        for _ in 0..<AuroraFluxFluid.PRESSURE_ITERS {
            blit(cmd, pPressure, to: prsB, params: &p, textures: [prsA, divT]); swap(&prsA, &prsB)
        }

        // 7. Subtract pressure gradient → divergence-free velocity.
        blit(cmd, pSubtract, to: velB, params: &p, textures: [velA, prsA]); swap(&velA, &velB)
    }

    private func springStep(_ cmd: MTLCommandBuffer, dt: Float) {
        lineParams.deltaTime = dt
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = stateB
        pass.colorAttachments[0].loadAction = .dontCare
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pSpring)
        var lp = lineParams
        enc.setFragmentBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        enc.setFragmentTexture(velA, index: 0)
        enc.setFragmentTexture(stateA, index: 1)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        swap(&stateA, &stateB)
    }
}

extension AuroraFluxFluid {
    /// Multi-pass fluid + line MSL. Ported 1:1 from the web `FluxFluid.ts` fluid
    /// passes and the `Drift.ts` spring/line shaders — same math, same constants.
    static let metal = """
    #include <metal_stdlib>
    using namespace metal;

    constexpr sampler linClamp(coord::normalized, filter::linear, address::clamp_to_edge);

    struct FSOut { float4 position [[position]]; float2 uv; };
    vertex FSOut fs_vertex(uint vid [[vertex_id]]) {
        float2 v[3] = { float2(-1.0,-1.0), float2(3.0,-1.0), float2(-1.0,3.0) };
        FSOut o; float2 p = v[vid];
        o.position = float4(p, 0.0, 1.0); o.uv = p * 0.5 + 0.5; return o;
    }

    struct FluidParams {
        float amount; float dissipation; float alpha; float rBeta;
        float deltaTime; float pad0; float2 texel;
        float4 chScale; float4 chMult; float4 chOffset;
    };
    struct LineParams {
        float2 gridSize; float aspect; float zoom;
        float lineLength; float lineVariance; float velGain; float deltaTime;
        float lineWidth; float beginOffset; float glow; float time;
        uint numLines; uint gx;
        float4 colorA; float4 colorB; float4 colorC;
    };

    // ---- 3D simplex noise (Ashima — identical to generate_noise.frag) ----------
    static float3 mod289(float3 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    static float4 mod289(float4 x){ return x - floor(x * (1.0/289.0)) * 289.0; }
    static float4 permute(float4 x){ return mod289(((x*34.0)+1.0)*x); }
    static float4 taylorInvSqrt(float4 r){ return 1.79284291400159 - 0.85373472095314 * r; }
    static float snoise(float3 v){
        const float2 C = float2(1.0/6.0, 1.0/3.0);
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
        float4 j = p - 49.0 * floor(p * (1.0/49.0));
        float4 x_ = floor(j * (1.0/7.0));
        float4 y_ = floor(j - 7.0 * x_);
        float4 x = x_ * (2.0/7.0) + 0.5/7.0 - 1.0;
        float4 y = y_ * (2.0/7.0) + 0.5/7.0 - 1.0;
        float4 h = 1.0 - abs(x) - abs(y);
        float4 b0 = float4(x.xy, y.xy);
        float4 b1 = float4(x.zw, y.zw);
        float4 s0 = floor(b0)*2.0 + 1.0;
        float4 s1 = floor(b1)*2.0 + 1.0;
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
        m = m*m; m = m*m;
        float4 px = float4(dot(x0,g0), dot(x1,g1), dot(x2,g2), dot(x3,g3));
        return 42.0 * dot(m, px);
    }
    static float2 makePair(float3 p){ return float2(snoise(p), snoise(p + float3(8.0,-8.0,0.0))); }

    // ---- Fluid passes ----------------------------------------------------------
    fragment float4 noise_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]]) {
        float2 uv = in.uv;
        float2 n = p.chMult.x * makePair(float3(p.chScale.x * uv, p.chOffset.x))
                 + p.chMult.y * makePair(float3(p.chScale.y * uv, p.chOffset.y))
                 + p.chMult.z * makePair(float3(p.chScale.z * uv, p.chOffset.z));
        return float4(n * 0.45, 0.0, 1.0);
    }
    fragment float4 advect_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        float2 tp = floor(size * in.uv);
        float2 v = vel.read(uint2(tp)).xy;
        float2 adv = ((tp + 0.5) - p.amount * v) / size;
        float decay = 1.0 + p.dissipation * p.amount;
        return float4(vel.sample(linClamp, adv).xy / decay, 0.0, 1.0);
    }
    fragment float4 adjust_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]],
                                texture2d<float> fwd [[texture(1)]],
                                texture2d<float> rev [[texture(2)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        uint2 pos = uint2(floor(in.uv * size));
        float2 v = vel.read(pos).xy;
        float2 sp = (0.5 + floor((float2(pos) + 1.0) - p.deltaTime * v)) / size;
        float2 t = p.texel;
        float2 L = vel.sample(linClamp, sp + float2(-t.x, 0.0)).xy;
        float2 R = vel.sample(linClamp, sp + float2( t.x, 0.0)).xy;
        float2 T = vel.sample(linClamp, sp + float2(0.0,  t.y)).xy;
        float2 B = vel.sample(linClamp, sp + float2(0.0, -t.y)).xy;
        float2 lo = min(L, min(R, min(T, B)));
        float2 hi = max(L, max(R, max(T, B)));
        float2 adjusted = fwd.read(pos).xy + 0.5 * (v - rev.read(pos).xy);
        return float4(clamp(adjusted, lo, hi), 0.0, 1.0);
    }
    fragment float4 diffuse_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                 texture2d<float> vel [[texture(0)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        float2 uv = in.uv; float2 t = p.texel;
        float2 c = vel.read(uint2(floor(size * uv))).xy;
        float2 L = vel.sample(linClamp, uv + float2(-t.x, 0.0)).xy;
        float2 R = vel.sample(linClamp, uv + float2( t.x, 0.0)).xy;
        float2 T = vel.sample(linClamp, uv + float2(0.0,  t.y)).xy;
        float2 B = vel.sample(linClamp, uv + float2(0.0, -t.y)).xy;
        return float4(p.rBeta * (L + R + B + T + p.alpha * c), 0.0, 1.0);
    }
    fragment float4 inject_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]], texture2d<float> noise [[texture(1)]]) {
        float2 v = vel.sample(linClamp, in.uv).xy;
        float2 n = noise.sample(linClamp, in.uv).xy;
        return float4(v + p.deltaTime * n, 0.0, 1.0);
    }
    fragment float4 divergence_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                    texture2d<float> vel [[texture(0)]]) {
        float2 uv = in.uv; float2 t = p.texel;
        float L = vel.sample(linClamp, uv + float2(-t.x, 0.0)).x;
        float R = vel.sample(linClamp, uv + float2( t.x, 0.0)).x;
        float T = vel.sample(linClamp, uv + float2(0.0,  t.y)).y;
        float B = vel.sample(linClamp, uv + float2(0.0, -t.y)).y;
        return float4(0.5 * ((R - L) + (T - B)), 0.0, 0.0, 1.0);
    }
    fragment float4 pressure_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                  texture2d<float> prs [[texture(0)]], texture2d<float> divt [[texture(1)]]) {
        float2 size = float2(divt.get_width(), divt.get_height());
        float2 uv = in.uv; float2 t = p.texel;
        float d = divt.read(uint2(floor(size * uv))).x;
        float L = prs.sample(linClamp, uv + float2(-t.x, 0.0)).x;
        float R = prs.sample(linClamp, uv + float2( t.x, 0.0)).x;
        float T = prs.sample(linClamp, uv + float2(0.0,  t.y)).x;
        float B = prs.sample(linClamp, uv + float2(0.0, -t.y)).x;
        return float4(p.rBeta * (L + R + B + T + p.alpha * d), 0.0, 0.0, 1.0);
    }
    fragment float4 subtract_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                  texture2d<float> vel [[texture(0)]], texture2d<float> prs [[texture(1)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        float2 uv = in.uv; float2 t = p.texel;
        float L = prs.sample(linClamp, uv + float2(-t.x, 0.0)).x;
        float R = prs.sample(linClamp, uv + float2( t.x, 0.0)).x;
        float T = prs.sample(linClamp, uv + float2(0.0,  t.y)).x;
        float B = prs.sample(linClamp, uv + float2(0.0, -t.y)).x;
        float2 v = vel.read(uint2(floor(size * uv))).xy;
        float2 boundary = float2(1.0);
        if (uv.x < t.x || uv.x > 1.0 - t.x) boundary.x = 0.0;
        if (uv.y < t.y || uv.y > 1.0 - t.y) boundary.y = 0.0;
        return float4(boundary * (v - 0.5 * float2(R - L, T - B)), 0.0, 1.0);
    }

    // ---- Line spring (Flux place_lines.vert, run as a fullscreen pass) ----------
    static float hashf(float2 pp){ pp = fract(pp * float2(123.34, 456.21)); pp += dot(pp, pp + 45.32); return fract(pp.x * pp.y); }
    fragment float4 spring_frag(FSOut in [[stage_in]], constant LineParams& p [[buffer(0)]],
                                texture2d<float> uVelocity [[texture(0)]], texture2d<float> uState [[texture(1)]]) {
        uint2 tc = uint2(in.position.xy);
        float2 grid = float2(tc);
        float2 basepoint = (grid + 0.5) / p.gridSize;
        float2 velocity = uVelocity.sample(linClamp, basepoint).xy * p.velGain;
        float4 st = uState.read(tc);
        float2 endpoint = st.xy; float2 springVel = st.zw;
        float variance = mix(1.0 - p.lineVariance, 1.0, hashf(grid));
        float vdb = mix(3.0, 25.0, 1.0 - variance);
        float mb = mix(3.0, 5.0, variance);
        float2 newVel = (1.0 - p.deltaTime * mb) * springVel
                      + (p.lineLength * velocity - endpoint) * vdb * p.deltaTime;
        float2 newEndpoint = endpoint + p.deltaTime * newVel;
        float len = length(newEndpoint);
        if (len > 0.6) newEndpoint *= 0.6 / len;
        return float4(newEndpoint, newVel);
    }

    // ---- Instanced line rendering (Flux line.vert / line.frag) ------------------
    static float3 palCyc(constant LineParams& p, float x) {
        float f = fract(x);
        if (f < 0.3333) return mix(p.colorA.rgb, p.colorB.rgb, f / 0.3333);
        if (f < 0.6666) return mix(p.colorB.rgb, p.colorC.rgb, (f - 0.3333) / 0.3333);
        return mix(p.colorC.rgb, p.colorA.rgb, (f - 0.6666) / 0.3334);
    }
    struct LineVOut { float4 position [[position]]; float2 vtx; float3 color; float alpha; float beginOffset; };
    vertex LineVOut line_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                constant LineParams& p [[buffer(0)]],
                                texture2d<float> uState [[texture(0)]],
                                texture2d<float> uVelocity [[texture(1)]]) {
        uint cell = (iid * 7001u) % p.numLines;
        uint gx = cell % p.gx; uint gy = cell / p.gx;
        float2 grid = float2(gx, gy);
        float2 basepoint = (grid + 0.5) / p.gridSize;
        float2 endpoint = uState.read(uint2(gx, gy)).xy;
        float2 fluidVel = uVelocity.sample(linClamp, basepoint).xy * p.velGain;
        float wb = clamp(2.5 * length(fluidVel), 0.0, 1.0);
        float lineWidth = wb * wb * (3.0 - 2.0 * wb);
        float cx = ((vid & 1u) == 0u) ? -0.5 : 0.5;
        float cy = (vid < 2u) ? 0.0 : 1.0;
        float2 xBasis = float2(-endpoint.y, endpoint.x);
        xBasis /= (length(xBasis) + 1e-4);
        float2 point = float2(p.aspect, 1.0) * p.zoom * (basepoint * 2.0 - 1.0)
                     + endpoint * cy + p.lineWidth * lineWidth * xBasis * cx;
        point.x /= p.aspect;
        LineVOut o;
        o.position = float4(point, 0.0, 1.0);
        o.vtx = float2(cx, cy);
        float shortBoost = 1.0 + (p.lineWidth * lineWidth) / (length(endpoint) + 1e-4);
        o.beginOffset = p.beginOffset / shortBoost;
        float angle = atan2(fluidVel.y, fluidVel.x) / 6.28318 + 0.5;
        o.color = palCyc(p, angle + 0.35 * (basepoint.x + basepoint.y) + 0.01 * p.time);
        o.alpha = wb;
        return o;
    }
    fragment float4 line_fragment(LineVOut in [[stage_in]], constant LineParams& p [[buffer(0)]]) {
        float fade = smoothstep(in.beginOffset, 1.0, in.vtx.y);
        float xo = abs(in.vtx.x);
        float edge = 1.0 - smoothstep(0.5 - fwidth(xo), 0.5, xo);
        float a = in.alpha * fade * edge;
        if (a <= 0.0009) discard_fragment();
        return float4(in.color * a * p.glow, 1.0);
    }
    """
}

