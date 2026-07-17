import Metal
import QuartzCore
import simd

/// Native Metal port of the faithful sandydoo/Flux implementation (matches the
/// web `Drift.ts` + `FluxFluid.ts` rewrite verified against flux.sandydoo.me).
///
/// Architecture (mirrors flux.rs::compute):
///  - REAL-TIME fluid: fixed 1/60 steps via an accumulator; the slow evolution
///    comes from noise offsets scrolling slowly, not from slowing the sim.
///  - Line springs integrate every frame with the raw frame delta.
///  - 12 floats of persistent per-line state in 3 MRT float textures: endpoint +
///    spring velocity, color + width, color velocity + opacity. Color is its own
///    damped spring chasing a velocity-derived target.
///  - Screen-space grid: one basepoint per 15 logical px (Flux Grid::new), line
///    length/width from view_scale * line_scale_factor.
///  - Lines accumulate in a LINEAR rgba16f texture with (SRC_ALPHA, ONE) blending,
///    then a final pass sRGB-encodes into the drawable (wgpu swapchain behavior).
final class AuroraFluxFluid {
    static let FLUID = 128                 // fluid grid (square, Flux fluid_size)
    static let GRID_SPACING: Float = 15    // logical px between basepoints
    static let FLUID_STEP: Float = 1.0 / 60
    static let MAX_FRAME_TIME: Float = 0.1
    static let ZOOM: Float = 1.6           // Flux view_scale
    static let VISCOSITY: Float = 5.0
    static let DIFFUSE_ITERS = 3
    static let PRESSURE_ITERS = 19

    // CPU-side mirrors of the MSL param structs (field order/padding must match).
    struct FluidParams {
        var amount: Float = 0, dissipation: Float = 0, alpha: Float = 0, rBeta: Float = 0
        var deltaTime: Float = 0, pad0: Float = 0
        var texel: SIMD2<Float> = .init(0, 0)
        var chScale: SIMD4<Float> = .init(0, 0, 0, 0)    // per-channel scale (breathes)
        var chMult: SIMD4<Float> = .init(0, 0, 0, 0)     // per-channel multiplier
        var chOffset1: SIMD4<Float> = .init(0, 0, 0, 0)  // per-channel offset 1
        var chOffset2: SIMD4<Float> = .init(0, 0, 0, 0)  // per-channel offset 2
        var chBlend: SIMD4<Float> = .init(0, 0, 0, 0)    // per-channel crossfade
    }
    struct LineParams {
        var gridSize: SIMD2<Float> = .init(1, 1)         // (cols, rows)
        var baseSpacing: SIMD2<Float> = .init(1, 1)      // (1/(cols-1), 1/(rows-1))
        var lineNoiseScale: SIMD2<Float> = .init(64, 64)
        var noiseOffset1: Float = 0
        var aspect: Float = 1
        var zoom: Float = ZOOM
        var lineLength: Float = 0
        var lineWidth: Float = 0
        var beginOffset: Float = 0.4
        var lineVariance: Float = 0.55                   // wgpu Flux default
        var deltaTime: Float = 1.0 / 60
        var glow: Float = 1
        var colorMode: UInt32 = 0                        // 0 = Original, 1 = wheel
        var cols: UInt32 = 1
        var rows: UInt32 = 1
        var noiseOffset2: Float = 0
        var noiseBlend: Float = 0
        var wheel: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>, SIMD4<Float>) =
            (.init(1, 1, 1, 1), .init(1, 1, 1, 1), .init(1, 1, 1, 1), .init(1, 1, 1, 1), .init(1, 1, 1, 1), .init(1, 1, 1, 1))
    }

    /// Exact port of Flux `NoiseChannel::tick` — the scale breathes ±15% on a slow
    /// sine and the offset crossfades to a fresh origin past the blend threshold.
    private final class NoiseChannel {
        let baseScale: Float, multiplier: Float, offsetIncrement: Float
        var scale: Float, offset1: Float, offset2: Float = 0, blendFactor: Float = 0
        init(_ baseScale: Float, _ multiplier: Float, _ offsetIncrement: Float) {
            self.baseScale = baseScale
            self.multiplier = multiplier
            self.offsetIncrement = offsetIncrement
            self.scale = baseScale
            self.offset1 = 4.0 * Float.random(in: 0...1)
        }
        func tick(_ elapsed: Float) {
            scale = baseScale * (1.0 + 0.15 * sin(0.01 * elapsed * 2 * Float.pi))
            offset1 += offsetIncrement
            if offset1 > 20.0 { blendFactor += offsetIncrement; offset2 += offsetIncrement }
            if blendFactor > 1.0 { offset1 = offset2; offset2 = 0; blendFactor = 0 }
        }
    }

    private let device: MTLDevice
    private let drawablePixelFormat: MTLPixelFormat

    // Fluid textures (ping-ponged). rg = velocity/noise, r = pressure/divergence.
    private var velA, velB, prsA, prsB, divT, noiseT, fwdT, revT: MTLTexture!
    // Line state MRT ping-pong: [0]=(endpoint, springVel) [1]=(color, width) [2]=(colorVel, opacity).
    private var stateA: [MTLTexture] = []
    private var stateB: [MTLTexture] = []
    // Linear accumulation target (rgba16f) + sRGB encode to the drawable.
    private var accT: MTLTexture?

    private var pNoise, pAdvect, pAdjust, pDiffuse, pInject, pDivergence, pPressure, pSubtract: MTLRenderPipelineState!
    private var pPlace: MTLRenderPipelineState!
    private var pLine: MTLRenderPipelineState!
    private var pEndpoint: MTLRenderPipelineState!
    private var pEncode: MTLRenderPipelineState!

    private var lineParams = LineParams()
    private let channels = [NoiseChannel(2.8, 1.0, 0.001), NoiseChannel(15.0, 0.7, 0.006), NoiseChannel(30.0, 0.5, 0.012)]

    // Flux timing state (flux.rs::compute).
    private var elapsedTime: Float = 0
    private var fluidFrameTime: Float = 0
    private var lastTime: Float = -1
    private var warmupLeft: Int = 60
    private var cleared = false

    // Line-noise offset state (LineUniforms::tick, per frame).
    private var lineNoiseOffset1: Float = 0
    private var lineNoiseOffset2: Float = 0
    private var lineNoiseBlendFactor: Float = 0

    // Current grid (rebuilt when the logical size or density changes).
    private var cols = 0, rows = 0
    private var gridDensity: Float = -1

    init?(device: MTLDevice, drawablePixelFormat: MTLPixelFormat) {
        self.device = device
        self.drawablePixelFormat = drawablePixelFormat
        do {
            let lib = try device.makeLibrary(source: AuroraFluxFluid.metal, options: nil)
            func frag(_ name: String, _ fmt: MTLPixelFormat, vfn: String = "fs_vertex") throws -> MTLRenderPipelineState {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = lib.makeFunction(name: vfn)
                d.fragmentFunction = lib.makeFunction(name: name)
                d.colorAttachments[0].pixelFormat = fmt
                return try device.makeRenderPipelineState(descriptor: d)
            }
            let rg = MTLPixelFormat.rg32Float, r = MTLPixelFormat.r32Float
            pNoise = try frag("noise_frag", rg)
            pAdvect = try frag("advect_frag", rg)
            pAdjust = try frag("adjust_frag", rg)
            pDiffuse = try frag("diffuse_frag", rg)
            pInject = try frag("inject_frag", rg)
            pDivergence = try frag("divergence_frag", r)
            pPressure = try frag("pressure_frag", r)
            pSubtract = try frag("subtract_frag", rg)

            // place_lines: MRT into the 3 state textures.
            let pd = MTLRenderPipelineDescriptor()
            pd.vertexFunction = lib.makeFunction(name: "fs_vertex")
            pd.fragmentFunction = lib.makeFunction(name: "place_frag")
            for i in 0..<3 { pd.colorAttachments[i].pixelFormat = .rgba32Float }
            pPlace = try device.makeRenderPipelineState(descriptor: pd)

            // Lines + endpoints accumulate into LINEAR rgba16f with (SRC_ALPHA, ONE).
            func drawPipe(_ vfn: String, _ ffn: String) throws -> MTLRenderPipelineState {
                let d = MTLRenderPipelineDescriptor()
                d.vertexFunction = lib.makeFunction(name: vfn)
                d.fragmentFunction = lib.makeFunction(name: ffn)
                d.colorAttachments[0].pixelFormat = .rgba16Float
                d.colorAttachments[0].isBlendingEnabled = true
                d.colorAttachments[0].rgbBlendOperation = .add
                d.colorAttachments[0].alphaBlendOperation = .add
                d.colorAttachments[0].sourceRGBBlendFactor = .sourceAlpha
                d.colorAttachments[0].destinationRGBBlendFactor = .one
                d.colorAttachments[0].sourceAlphaBlendFactor = .one
                d.colorAttachments[0].destinationAlphaBlendFactor = .one
                return try device.makeRenderPipelineState(descriptor: d)
            }
            pLine = try drawPipe("line_vertex", "line_fragment")
            pEndpoint = try drawPipe("endpoint_vertex", "endpoint_fragment")

            // Final linear→sRGB encode into the drawable.
            let ed = MTLRenderPipelineDescriptor()
            ed.vertexFunction = lib.makeFunction(name: "fs_vertex")
            ed.fragmentFunction = lib.makeFunction(name: "encode_frag")
            ed.colorAttachments[0].pixelFormat = drawablePixelFormat
            pEncode = try device.makeRenderPipelineState(descriptor: ed)
        } catch {
            NSLog("[Aurora] Flux fluid pipeline build failed: \(error)")
            return nil
        }
        guard makeFluidTextures() else { return nil }
    }

    private func tex(_ w: Int, _ h: Int, _ fmt: MTLPixelFormat) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: fmt, width: w, height: h, mipmapped: false)
        d.usage = [.renderTarget, .shaderRead]
        d.storageMode = .private
        return device.makeTexture(descriptor: d)
    }

    private func makeFluidTextures() -> Bool {
        let n = AuroraFluxFluid.FLUID
        guard let a = tex(n, n, .rg32Float), let b = tex(n, n, .rg32Float),
              let pa = tex(n, n, .r32Float), let pb = tex(n, n, .r32Float),
              let dv = tex(n, n, .r32Float), let no = tex(2 * n, 2 * n, .rg32Float), // noise = 2× fluid (Flux)
              let fw = tex(n, n, .rg32Float), let rv = tex(n, n, .rg32Float) else { return false }
        velA = a; velB = b; prsA = pa; prsB = pb; divT = dv; noiseT = no; fwdT = fw; revT = rv
        return true
    }

    /// Flux's line_scale_factor: normalizes pixel-unit line length/width to clip.
    private static func lineScaleFactor(_ w: Float, _ h: Float) -> Float {
        let p = h / w
        return 1.0 / min((1.0 - p) * w + p * h, 2000.0)
    }

    /// (Re)build the grid + state textures from the logical size and density.
    /// Returns false if texture allocation fails (encode() then draws nothing).
    private func rebuildGrid(logicalW: Float, logicalH: Float, density: Float, cmd: MTLCommandBuffer) -> Bool {
        // clamp_logical_size: upscale tiny viewports to a working minimum.
        let upscale = max(800 / logicalW, 800 / logicalH, 1)
        let lw = logicalW * upscale, lh = logicalH * upscale
        let spacing = AuroraFluxFluid.GRID_SPACING / (0.5 + density) // density 0.5 → Flux's 15
        let cols0 = max(1, Int(lw / spacing)), rows0 = max(1, Int((lh / lw) * Float(cols0)))
        let newCols = cols0 + 1, newRows = rows0 + 1
        if newCols != cols || newRows != rows {
            cols = newCols; rows = newRows
            stateA = []; stateB = []
            for _ in 0..<3 {
                guard let a = tex(cols, rows, .rgba32Float), let b = tex(cols, rows, .rgba32Float) else {
                    cols = 0; rows = 0
                    return false
                }
                stateA.append(a); stateB.append(b)
            }
            for t in stateA + stateB { clearZero(cmd, t) }
        }
        lineParams.gridSize = .init(Float(cols), Float(rows))
        lineParams.baseSpacing = .init(1 / Float(cols0), 1 / Float(rows0))
        lineParams.cols = UInt32(cols); lineParams.rows = UInt32(rows)
        lineParams.lineNoiseScale = .init(64 * max(Float(cols) / 171, 1), 64 * max(Float(rows) / 171, 1))
        lineParams.aspect = lw / lh
        return true
    }

    /// Draw one fluid-driven frame of Flux Drift into `target`.
    func encode(into cmd: MTLCommandBuffer, target: MTLTexture, uniforms u: AuroraUniforms) {
        // Raw frame delta scaled by the Speed control (0.3 = 1× real-time = Flux).
        let now = u.time
        let realDelta: Float = (lastTime < 0) ? (1.0 / 60) : max(0, min(now - lastTime, 0.25))
        lastTime = now
        let dt = min(realDelta, AuroraFluxFluid.MAX_FRAME_TIME) * (u.speed / 0.3)

        // Logical size from drawable px / content scale (pad1.x; 2 = Retina default).
        let contentScale = u.pad1.x > 0 ? u.pad1.x : 2
        let logicalW = max(u.resolution.x / contentScale, 1)
        let logicalH = max(u.resolution.y / contentScale, 1)
        guard rebuildGrid(logicalW: logicalW, logicalH: logicalH, density: u.density, cmd: cmd) else { return }

        // Controls: Size → stroke scale; Intensity → brightness; Style → color mode
        // (palette 0 = Flux "Original" velocity coloring, others = color wheel).
        let lsf = AuroraFluxFluid.lineScaleFactor(logicalW * max(800 / logicalW, 800 / logicalH, 1),
                                                  logicalH * max(800 / logicalW, 800 / logicalH, 1))
        let sizeF = 1.0 + 0.5 * (u.size - 0.85)
        lineParams.lineWidth = AuroraFluxFluid.ZOOM * 9.0 * lsf * sizeF
        lineParams.lineLength = AuroraFluxFluid.ZOOM * 450.0 * lsf * sizeF
        lineParams.glow = 0.5 + 0.5 * u.intensity
        lineParams.colorMode = u.pad1.y > 0.5 ? 1 : 0
        lineParams.wheel = (u.colorA, u.colorB, u.colorC, u.colorA, u.colorB, u.colorC)

        // Metal .private textures start with UNDEFINED contents; zero them once.
        if !cleared {
            cleared = true
            for t in [velA, velB, prsA, prsB, divT, noiseT, fwdT, revT] { clearZero(cmd, t) }
        }

        if dt > 0 {
            elapsedTime += dt
            if elapsedTime >= 1000 { elapsedTime -= 1000 } // MAX_ELAPSED_TIME wrap
            fluidFrameTime += dt
        }

        // Amortized warm-up: a few extra fluid steps per frame at startup (bounded —
        // a 60-step burst could trip slower GPUs / the Windows TDR watchdog).
        if warmupLeft > 0 {
            let n = min(warmupLeft, 8)
            for _ in 0..<n { fluidStep(cmd) }
            warmupLeft -= n
        }

        // Fluid: fixed 1/60 steps in real time (accumulator, NOT one step per frame).
        var steps = 0
        while fluidFrameTime >= AuroraFluxFluid.FLUID_STEP && steps < 6 {
            fluidStep(cmd)
            fluidFrameTime -= AuroraFluxFluid.FLUID_STEP
            steps += 1
        }
        if fluidFrameTime > AuroraFluxFluid.FLUID_STEP { fluidFrameTime = AuroraFluxFluid.FLUID_STEP }

        // Lines: place with the RAW frame delta (Flux line animation timing).
        tickLineNoise(dt: dt)
        placeStep(cmd, dt: dt)

        // Accumulate lines + endpoints in LINEAR space, then sRGB-encode to target.
        if accT == nil || accT!.width != target.width || accT!.height != target.height {
            accT = tex(target.width, target.height, .rgba16Float)
        }
        guard let acc = accT else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = acc
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1) // Flux: pure black
        pass.colorAttachments[0].storeAction = .store
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        var lp = lineParams
        let count = cols * rows
        enc.setRenderPipelineState(pLine)
        enc.setVertexBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        for (i, t) in stateA.enumerated() { enc.setVertexTexture(t, index: i) }
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: count)
        enc.setRenderPipelineState(pEndpoint)
        enc.setVertexBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4, instanceCount: count)
        enc.endEncoding()

        let ep = MTLRenderPassDescriptor()
        ep.colorAttachments[0].texture = target
        ep.colorAttachments[0].loadAction = .dontCare
        ep.colorAttachments[0].storeAction = .store
        guard let ee = cmd.makeRenderCommandEncoder(descriptor: ep) else { return }
        ee.setRenderPipelineState(pEncode)
        ee.setFragmentTexture(acc, index: 0)
        ee.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        ee.endEncoding()
    }

    /// Flux drawer.rs LineUniforms::tick — line-variance noise scroll, per frame.
    private func tickLineNoise(dt: Float) {
        guard dt > 0 else { return }
        let perturb = 1.0 + 0.2 * sin(0.01 * elapsedTime * 2 * Float.pi)
        let offset: Float = 0.0015 * perturb
        lineNoiseOffset1 += offset
        if lineNoiseOffset1 > 4.0 { lineNoiseOffset2 += offset; lineNoiseBlendFactor += 0.0015 }
        if lineNoiseBlendFactor > 1.0 {
            lineNoiseOffset1 = lineNoiseOffset2
            lineNoiseOffset2 = 0
            lineNoiseBlendFactor = 0
        }
        lineParams.noiseOffset1 = lineNoiseOffset1
        lineParams.noiseOffset2 = lineNoiseOffset2
        lineParams.noiseBlend = lineNoiseBlendFactor
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

    /// One fixed 1/60 fluid step (flux.rs compute loop body). Ticks noise channels.
    private func fluidStep(_ cmd: MTLCommandBuffer) {
        let dt = AuroraFluxFluid.FLUID_STEP
        let texel = SIMD2<Float>(1.0 / Float(AuroraFluxFluid.FLUID), 1.0 / Float(AuroraFluxFluid.FLUID))
        var p = FluidParams(); p.texel = texel; p.deltaTime = dt

        // 1. Noise force field (channel state: breathing scale + offset crossfade).
        p.chScale = .init(channels[0].scale, channels[1].scale, channels[2].scale, 0)
        p.chMult = .init(channels[0].multiplier, channels[1].multiplier, channels[2].multiplier, 0)
        p.chOffset1 = .init(channels[0].offset1, channels[1].offset1, channels[2].offset1, 0)
        p.chOffset2 = .init(channels[0].offset2, channels[1].offset2, channels[2].offset2, 0)
        p.chBlend = .init(channels[0].blendFactor, channels[1].blendFactor, channels[2].blendFactor, 0)
        blit(cmd, pNoise, to: noiseT, params: &p, textures: [])
        for c in channels { c.tick(elapsedTime) }

        // 2. MacCormack advection: forward, reverse, adjust. dissipation 0 (Flux).
        p.dissipation = 0
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

        // 6. Pressure Jacobi — wgpu Flux clears pressure to 0 each solve (ClearWith).
        clearZero(cmd, prsA)
        p.alpha = -1; p.rBeta = 0.25
        for _ in 0..<AuroraFluxFluid.PRESSURE_ITERS {
            blit(cmd, pPressure, to: prsB, params: &p, textures: [prsA, divT]); swap(&prsA, &prsB)
        }

        // 7. Subtract pressure gradient → divergence-free velocity.
        blit(cmd, pSubtract, to: velB, params: &p, textures: [velA, prsA]); swap(&velA, &velB)
    }

    /// place_lines: fullscreen MRT pass over the 3 state textures (raw frame dt).
    private func placeStep(_ cmd: MTLCommandBuffer, dt: Float) {
        guard dt > 0, stateA.count == 3 else { return }
        lineParams.deltaTime = dt
        let pass = MTLRenderPassDescriptor()
        for i in 0..<3 {
            pass.colorAttachments[i].texture = stateB[i]
            pass.colorAttachments[i].loadAction = .dontCare
            pass.colorAttachments[i].storeAction = .store
        }
        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return }
        enc.setRenderPipelineState(pPlace)
        var lp = lineParams
        enc.setFragmentBytes(&lp, length: MemoryLayout<LineParams>.stride, index: 0)
        enc.setFragmentTexture(velA, index: 0)
        for (i, t) in stateA.enumerated() { enc.setFragmentTexture(t, index: i + 1) }
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        swap(&stateA, &stateB)
    }
}

extension AuroraFluxFluid {
    /// Multi-pass fluid + line MSL. Ported 1:1 from the web `FluxFluid.ts` fluid
    /// passes and the faithful `Drift.ts` place/line/endpoint shaders.
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
        float4 chScale; float4 chMult; float4 chOffset1; float4 chOffset2; float4 chBlend;
    };
    struct LineParams {
        float2 gridSize; float2 baseSpacing; float2 lineNoiseScale;
        float noiseOffset1; float aspect; float zoom;
        float lineLength; float lineWidth; float beginOffset;
        float lineVariance; float deltaTime; float glow;
        uint colorMode; uint cols; uint rows; float noiseOffset2; float noiseBlend;
        float4 wheel[6];
    };

    // ---- 3D simplex noise (Ashima), same as Flux ----------------------------
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

    // ---- Fluid passes (identical math to the web FluxFluid.ts) ---------------
    static float2 makePair(float3 p){ return float2(snoise(p), snoise(p + float3(8.0, -8.0, 0.0))); }
    static float2 channel(float2 uv, float scale, float mult, float off1, float off2, float blend){
        float2 pos = scale * uv;
        float2 n = makePair(float3(pos, off1));
        if (blend > 0.0) n = mix(n, makePair(float3(pos, off2)), blend);
        return mult * n;
    }
    fragment float4 noise_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]]) {
        float2 n = channel(in.uv, p.chScale.x, p.chMult.x, p.chOffset1.x, p.chOffset2.x, p.chBlend.x)
                 + channel(in.uv, p.chScale.y, p.chMult.y, p.chOffset1.y, p.chOffset2.y, p.chBlend.y)
                 + channel(in.uv, p.chScale.z, p.chMult.z, p.chOffset1.z, p.chOffset2.z, p.chBlend.z);
        return float4(n * 0.45, 0.0, 1.0);
    }
    fragment float4 advect_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        float2 texelPos = floor(size * in.uv);
        float2 velocity = vel.read(uint2(texelPos)).xy;
        float2 advectedPos = ((texelPos + 0.5) - p.amount * velocity) / size;
        float decay = 1.0 + p.dissipation * p.amount;
        return float4(vel.sample(linClamp, advectedPos).xy / decay, 0.0, 1.0);
    }
    fragment float4 adjust_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]],
                                texture2d<float> fwd [[texture(1)]],
                                texture2d<float> rev [[texture(2)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        uint2 pos = uint2(floor(in.uv * size));
        float2 velocity = vel.read(pos).xy;
        float2 sp = (0.5 + floor((float2(pos) + 1.0) - p.deltaTime * velocity)) / size;
        float2 t = 1.0 / size;
        float2 L = vel.sample(linClamp, sp + float2(-t.x, 0.0)).xy;
        float2 R = vel.sample(linClamp, sp + float2( t.x, 0.0)).xy;
        float2 T = vel.sample(linClamp, sp + float2(0.0,  t.y)).xy;
        float2 B = vel.sample(linClamp, sp + float2(0.0, -t.y)).xy;
        float2 lo = min(L, min(R, min(T, B)));
        float2 hi = max(L, max(R, max(T, B)));
        float2 forward = fwd.read(pos).xy;
        float2 reverse = rev.read(pos).xy;
        float2 adjusted = forward + 0.5 * (velocity - reverse);
        return float4(clamp(adjusted, lo, hi), 0.0, 1.0);
    }
    fragment float4 diffuse_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                 texture2d<float> vel [[texture(0)]]) {
        float2 size = float2(vel.get_width(), vel.get_height());
        float2 velocity = vel.read(uint2(floor(size * in.uv))).xy;
        float2 t = p.texel;
        float2 L = vel.sample(linClamp, in.uv + float2(-t.x, 0.0)).xy;
        float2 R = vel.sample(linClamp, in.uv + float2( t.x, 0.0)).xy;
        float2 T = vel.sample(linClamp, in.uv + float2(0.0,  t.y)).xy;
        float2 B = vel.sample(linClamp, in.uv + float2(0.0, -t.y)).xy;
        return float4(p.rBeta * (L + R + B + T + p.alpha * velocity), 0.0, 1.0);
    }
    fragment float4 inject_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                texture2d<float> vel [[texture(0)]], texture2d<float> noi [[texture(1)]]) {
        float2 velocity = vel.sample(linClamp, in.uv).xy;
        float2 noise = noi.sample(linClamp, in.uv).xy;
        return float4(velocity + p.deltaTime * noise, 0.0, 1.0);
    }
    fragment float4 divergence_frag(FSOut in [[stage_in]], constant FluidParams& p [[buffer(0)]],
                                    texture2d<float> vel [[texture(0)]]) {
        float2 t = p.texel;
        float L = vel.sample(linClamp, in.uv + float2(-t.x, 0.0)).x;
        float R = vel.sample(linClamp, in.uv + float2( t.x, 0.0)).x;
        float T = vel.sample(linClamp, in.uv + float2(0.0,  t.y)).y;
        float B = vel.sample(linClamp, in.uv + float2(0.0, -t.y)).y;
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

    // ---- place_lines (Flux place_lines, MRT over 3 state textures) ----------
    // [0] endpoint.xy + springVel.zw  [1] color.rgb + width  [2] colorVel.xyz + opacity
    struct PlaceOut {
        float4 endVel     [[color(0)]];
        float4 colorWidth [[color(1)]];
        float4 colorVel   [[color(2)]];
    };
    static float3 wheelColor(constant LineParams& p, float angle) {
        const float TAU = 6.283185307179586;
        float slice = TAU / 6.0;
        float rawIndex = fmod(fmod(angle, TAU) + TAU, TAU) / slice;
        float index = floor(rawIndex);
        float nextIndex = fmod(index + 1.0, 6.0);
        return mix(p.wheel[int(index)].rgb, p.wheel[int(nextIndex)].rgb, fract(rawIndex));
    }
    fragment PlaceOut place_frag(FSOut in [[stage_in]], constant LineParams& p [[buffer(0)]],
                                 texture2d<float> uVelocity [[texture(0)]],
                                 texture2d<float> uState0 [[texture(1)]],
                                 texture2d<float> uState1 [[texture(2)]],
                                 texture2d<float> uState2 [[texture(3)]]) {
        uint2 tc = uint2(in.position.xy);
        float2 basepoint = float2(tc) * p.baseSpacing;
        float2 velocity = uVelocity.sample(linClamp, basepoint).xy;
        float4 st = uState0.read(tc);
        float4 cw = uState1.read(tc);
        float4 cv = uState2.read(tc);

        // Crossfade between two noise offsets (Flux): without the blend, the
        // periodic offset swap pops every line's variance at once.
        float noise = snoise(float3(p.lineNoiseScale * basepoint, p.noiseOffset1));
        if (p.noiseBlend > 0.0) {
            float noise2 = snoise(float3(p.lineNoiseScale * basepoint, p.noiseOffset2));
            noise = mix(noise, noise2, p.noiseBlend);
        }
        float variance = mix(1.0 - p.lineVariance, 1.0, 0.5 + 0.5 * noise);
        float velocityDeltaBoost = mix(3.0, 25.0, 1.0 - variance);
        float momentumBoost = mix(3.0, 5.0, variance);

        float2 newVel = (1.0 - p.deltaTime * momentumBoost) * st.zw
                      + (p.lineLength * velocity - st.xy) * velocityDeltaBoost * p.deltaTime;
        float2 newEndpoint = st.xy + p.deltaTime * newVel;

        float widthBoost = clamp(2.5 * length(velocity), 0.0, 1.0);
        float width = widthBoost * widthBoost * (3.0 - widthBoost * 2.0);

        float3 target;
        if (p.colorMode == 0u) {
            target = float3(clamp(float2(1.0, 0.66) * (0.5 + velocity), 0.0, 1.0), 0.5);
        } else {
            target = wheelColor(p, atan2(velocity.x, velocity.y));
        }
        float3 colorVel = cv.xyz * (1.0 - 3.0 * p.deltaTime) + (target - cw.rgb) * 90.0 * p.deltaTime;
        float3 color = clamp(cw.rgb + p.deltaTime * colorVel, 0.0, 1.0);

        PlaceOut o;
        o.endVel = float4(newEndpoint, newVel);
        o.colorWidth = float4(color, width);
        o.colorVel = float4(colorVel, width); // opacity = smoothstepped widthBoost (wgpu Flux)
        return o;
    }

    // ---- Line rendering (Flux line shaders) ----------------------------------
    struct LineVOut { float4 position [[position]]; float2 vtx; float4 color; float lineOffset; };
    vertex LineVOut line_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                constant LineParams& p [[buffer(0)]],
                                texture2d<float> uState0 [[texture(0)]],
                                texture2d<float> uState1 [[texture(1)]],
                                texture2d<float> uState2 [[texture(2)]]) {
        uint u = iid % p.cols; uint v = iid / p.cols;
        float2 basepoint = float2(u, v) * p.baseSpacing;
        float2 endpoint = uState0.read(uint2(u, v)).xy;
        float4 cw = uState1.read(uint2(u, v));
        float opacity = uState2.read(uint2(u, v)).w;
        // Quad template: x in {-0.5, 0.5}, y in {0, 1}.
        float cx = ((vid & 1u) == 0u) ? -0.5 : 0.5;
        float cy = (vid < 2u) ? 0.0 : 1.0;
        float2 xBasis = float2(-endpoint.y, endpoint.x);
        xBasis /= (length(xBasis) + 0.0001);
        float2 pt = float2(p.aspect, 1.0) * p.zoom * (basepoint * 2.0 - 1.0)
                  + endpoint * cy
                  + p.lineWidth * cw.a * xBasis * cx;
        pt.x /= p.aspect;
        LineVOut o;
        o.position = float4(pt, 0.0, 1.0);
        o.vtx = float2(cx, cy);
        o.color = float4(cw.rgb * p.glow, opacity);
        float shortBoost = 1.0 + (p.lineWidth * cw.a) / (length(endpoint) + 1e-6);
        o.lineOffset = p.beginOffset / shortBoost;
        return o;
    }
    fragment float4 line_fragment(LineVOut in [[stage_in]]) {
        float fade = smoothstep(in.lineOffset, 1.0, in.vtx.y);
        float xo = abs(in.vtx.x);
        float edge = 1.0 - smoothstep(0.5 - fwidth(xo), 0.5, xo);
        return float4(in.color.rgb, in.color.a * fade * edge);
    }

    // ---- Endpoint rendering (Flux endpoint shaders) ---------------------------
    struct EndVOut { float4 position [[position]]; float2 vtx; float2 midpoint; float4 top; float4 bottom; };
    vertex EndVOut endpoint_vertex(uint vid [[vertex_id]], uint iid [[instance_id]],
                                   constant LineParams& p [[buffer(0)]],
                                   texture2d<float> uState0 [[texture(0)]],
                                   texture2d<float> uState1 [[texture(1)]],
                                   texture2d<float> uState2 [[texture(2)]]) {
        uint u = iid % p.cols; uint v = iid / p.cols;
        float2 basepoint = float2(u, v) * p.baseSpacing;
        float2 endpoint = uState0.read(uint2(u, v)).xy;
        float4 cw = uState1.read(uint2(u, v));
        float opacity = uState2.read(uint2(u, v)).w;
        // Quad corner in [-1,1]^2.
        float2 corner = float2(((vid & 1u) == 0u) ? -1.0 : 1.0, (vid < 2u) ? -1.0 : 1.0);
        float2 pt = float2(p.aspect, 1.0) * p.zoom * (basepoint * 2.0 - 1.0)
                  + endpoint
                  + 0.5 * p.lineWidth * cw.a * corner;
        pt.x /= p.aspect;
        EndVOut o;
        o.position = float4(pt, 0.0, 1.0);
        o.vtx = corner;
        o.midpoint = float2(endpoint.y, -endpoint.x); // endpoint rotated 90°
        float3 rgb = cw.rgb * p.glow;
        o.top = float4(rgb, 1.0);
        // Compensate for the line already drawn underneath (premultiplied reverse-blend).
        o.bottom = float4(rgb - rgb * opacity, 1.0);
        return o;
    }
    fragment float4 endpoint_fragment(EndVOut in [[stage_in]]) {
        float4 color = in.bottom;
        float side = (in.vtx.x - in.midpoint.x) * (-in.midpoint.y)
                   - (in.vtx.y - in.midpoint.y) * (-in.midpoint.x);
        if (side > 0.0) color = in.top;
        float dist = length(in.vtx);
        float edge = 1.0 - smoothstep(1.0 - fwidth(dist), 1.0, dist);
        return float4(color.rgb, color.a * edge);
    }

    // ---- Final linear → sRGB encode (wgpu swapchain behavior) -----------------
    static float3 srgbEncode(float3 c) {
        c = clamp(c, 0.0, 1.0);
        return select(1.055 * pow(c, float3(1.0 / 2.4)) - 0.055, 12.92 * c, c < 0.0031308);
    }
    fragment float4 encode_frag(FSOut in [[stage_in]], texture2d<float> acc [[texture(0)]]) {
        return float4(srgbEncode(acc.sample(linClamp, in.uv).rgb), 1.0);
    }
    """
}
