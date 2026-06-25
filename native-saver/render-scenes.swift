import Metal
import AppKit
import Foundation
import simd

// Headless visual verification of the native Metal scenes: compiles the saver's
// MSL, renders each scene to an offscreen texture, and writes a PNG. Proves the
// Metal ports actually render (not just compile) without needing System Settings.
@main
struct RenderScenes {
    static func fail(_ m: String) -> Never {
        FileHandle.standardError.write("render-scenes FAILED: \(m)\n".data(using: .utf8)!)
        exit(1)
    }

    static func main() {
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/aurora-native-shots"
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fail("no Metal device") }

        let pipeline: MTLRenderPipelineState
        do {
            let lib = try device.makeLibrary(source: AuroraShaderSource.metal, options: nil)
            let d = MTLRenderPipelineDescriptor()
            d.vertexFunction = lib.makeFunction(name: "aurora_vertex")
            d.fragmentFunction = lib.makeFunction(name: "aurora_fragment")
            d.colorAttachments[0].pixelFormat = .rgba8Unorm
            pipeline = try device.makeRenderPipelineState(descriptor: d)
        } catch { fail("pipeline: \(error)") }

        let W = 800, H = 500
        let texDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rgba8Unorm, width: W, height: H, mipmapped: false)
        texDesc.usage = [.renderTarget, .shaderRead]
        texDesc.storageMode = .shared
        guard let tex = device.makeTexture(descriptor: texDesc) else { fail("texture") }

        // Scene index → (palette index, intensity, density), matching app defaults.
        let configs: [(scene: Int, palette: Int, intensity: Float, density: Float)] = [
            (0, 0, 1.0, 0.5),  // Aurora Drift / Aurora
            (1, 1, 1.0, 0.5),  // Northern Lights / Borealis
            (2, 2, 0.9, 0.6),  // Deep Space / Deep Space
            (3, 5, 1.2, 0.8),  // Particle Drift / Synthwave
            (4, 5, 1.0, 0.5),  // Plasma Field / Synthwave
            (5, 8, 1.0, 0.55), // Matrix Rain / Mint
            (6, 4, 1.0, 0.5),  // Fireflies / Ember
            (7, 10, 1.0, 0.5), // Black Hole / Ice
            (8, 2, 1.0, 0.5),  // Hyperspace Tunnel / Deep Space
            (9, 5, 1.0, 0.5),  // Synthwave / Synthwave
            (10, 7, 1.0, 0.5), // Kaleidoscope / Nebula
            (11, 3, 1.0, 0.5), // Caustics / Ocean
            (12, 3, 1.0, 0.5), // Polar Clock / Ocean
        ]

        for cfg in configs {
            var u = AuroraUniforms()
            u.scene = Float(cfg.scene)
            u.time = 9.0
            u.speed = 0.4
            u.intensity = cfg.intensity
            u.density = cfg.density
            u.resolution = SIMD2<Float>(Float(W), Float(H))
            let p = AuroraPalette.all[cfg.palette]
            u.colorA = p.a; u.colorB = p.b; u.colorC = p.c
            // Polar clock: a representative time (10:08:30, 15th, ~June).
            u.clock = SIMD4<Float>(0.5, 0.14, (10.0 + 8.0/60.0)/24.0, 14.0/30.0)
            u.month = 5.4/12.0
            u.ticks = 1

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

            // Read back RGBA and write a PNG.
            let bytesPerRow = W * 4
            var raw = [UInt8](repeating: 0, count: bytesPerRow * H)
            tex.getBytes(&raw, bytesPerRow: bytesPerRow,
                         from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
            guard let rep = NSBitmapImageRep(
                bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                colorSpaceName: .deviceRGB, bytesPerRow: bytesPerRow, bitsPerPixel: 32)
            else { fail("bitmap rep") }
            memcpy(rep.bitmapData!, raw, raw.count)
            guard let png = rep.representation(using: .png, properties: [:]) else { fail("png encode") }
            let path = "\(outDir)/native-\(cfg.scene)-\(AuroraScene.all[cfg.scene].name.replacingOccurrences(of: " ", with: "")).png"
            try? png.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
        print("render-scenes OK")
        exit(0)
    }
}
