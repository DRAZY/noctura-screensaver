import Metal
import Foundation
import simd

// Headless GPU-cost probe. Renders the real saver shader for every scene at a
// representative high resolution and reports the measured GPU execution time per
// frame (gpuEndTime - gpuStartTime). Two jobs:
//   1. Confirm this GPU actually reports command-buffer timestamps — the signal
//      the Auto performance controller scales against. A zero here means Auto
//      would fall back to frame-time-overrun detection.
//   2. Sanity-check relative per-scene cost so the adaptive bands are realistic.
@main
struct GPUTimeCheck {
    static func fail(_ m: String) -> Never {
        FileHandle.standardError.write("gpu-time-check FAILED: \(m)\n".data(using: .utf8)!)
        exit(1)
    }

    static func main() {
        // Default to a 2880x1800 frame (~5.2 MP — a Retina 15"/4K-ish load).
        let W = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 2880 : 2880
        let H = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 1800 : 1800

        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fail("no Metal device") }

        let pipeline: MTLRenderPipelineState
        do {
            let lib = try device.makeLibrary(source: AuroraShaderSource.metal, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "aurora_vertex")
            d.fragmentFunction = lib.makeFunction(name: "aurora_fragment")
            d.colorAttachments[0].pixelFormat = .bgra8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: d)
        } catch { fail("pipeline: \(error)") }

        let texDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: W, height: H, mipmapped: false)
        texDesc.usage = .renderTarget
        texDesc.storageMode = .private
        guard let tex = device.makeTexture(descriptor: texDesc) else { fail("texture") }

        print("gpu-time-check: \(device.name) @ \(W)x\(H) (\(String(format: "%.1f", Double(W*H)/1_000_000)) MP)")

        let frameBudget60 = 1.0 / 60.0
        var anyNonzero = false
        var worst = 0.0

        for sceneIndex in 0..<AuroraScene.all.count {
            var u = AuroraUniforms()
            u.scene = Float(sceneIndex)
            u.time = 9.0
            u.speed = 0.4
            u.intensity = 1.0
            u.density = 0.6
            u.size = 0.85
            u.resolution = SIMD2<Float>(Float(W), Float(H))
            let p = AuroraPalette.all[sceneIndex % AuroraPalette.all.count]
            u.colorA = p.a; u.colorB = p.b; u.colorC = p.c
            u.clock = SIMD4<Float>(0.5, 0.14, 0.42, 0.47)
            u.month = 0.45
            u.ticks = 1

            // Warm up once, then take the best of several timed frames (best =
            // least disturbed by scheduling noise).
            var best = Double.greatestFiniteMagnitude
            for iter in 0..<6 {
                let pass = MTLRenderPassDescriptor()
                pass.colorAttachments[0].texture = tex
                pass.colorAttachments[0].loadAction = .clear
                pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
                pass.colorAttachments[0].storeAction = .store
                guard let cmd = queue.makeCommandBuffer(),
                      let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { fail("encoder") }
                enc.setRenderPipelineState(pipeline)
                enc.setFragmentBytes(&u, length: MemoryLayout<AuroraUniforms>.stride, index: 0)
                enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
                enc.endEncoding()
                cmd.commit()
                cmd.waitUntilCompleted()
                let span = cmd.gpuEndTime - cmd.gpuStartTime
                if iter > 0, span > 0 { best = min(best, span) }
            }
            if best == .greatestFiniteMagnitude { best = 0 }
            if best > 0 { anyNonzero = true }
            worst = max(worst, best)
            let pct = best / frameBudget60 * 100
            let name = AuroraScene.all[sceneIndex].name
            print(String(format: "  scene %2d  %-18@  %.3f ms  (%.0f%% of 60fps budget)",
                         sceneIndex, name as NSString, best * 1000, pct))
        }

        guard anyNonzero else {
            fail("GPU timestamps all zero — Auto would use the frame-time fallback on this GPU")
        }

        // COST CEILING (regression gate). The adaptive controller keeps a scene
        // smooth by dropping resolution (to ≈quarter native) and, last resort, to
        // 30 fps — so at the floor a scene renders ~1/4 of these pixels. For that to
        // still fit the 30 fps budget, full-res cost here must stay under ~130 ms.
        // We fail the build past `maxMs` (default 180, generous headroom on this
        // reference GPU) so a catastrophic scene — like the 605 ms/frame Flux Drift
        // that once froze a machine — can NEVER ship again. Tune via env if a much
        // slower CI GPU needs a higher ceiling.
        let worstMs = worst * 1000
        let maxMs = ProcessInfo.processInfo.environment["NOCTURA_MAX_SCENE_MS"].flatMap { Double($0) } ?? 180.0
        let warnMs = 100.0
        print(String(format: "gpu-time-check: worst scene = %.1f ms (%.0f%% of 60fps budget at %dx%d); ceiling = %.0f ms",
                     worstMs, worst / frameBudget60 * 100, W, H, maxMs))
        if worstMs > maxMs {
            fail(String(format: "a scene costs %.1f ms/frame at %dx%d — over the %.0f ms ceiling. Even at the adaptive resolution floor this would bog down weaker GPUs. Make the scene cheaper.", worstMs, W, H, maxMs))
        }
        if worstMs > warnMs {
            FileHandle.standardError.write(String(format: "gpu-time-check WARNING: worst scene %.1f ms is heavy (> %.0f ms); it will run at reduced resolution on most GPUs.\n", worstMs, warnMs).data(using: .utf8)!)
        }
        print("gpu-time-check OK — all scenes within the cost ceiling.")
        exit(0)
    }
}
