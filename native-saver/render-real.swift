import Metal
import QuartzCore
import AppKit
import Foundation
import simd

// Renders scenes through the REAL AuroraRenderer.encodeFrame dispatch — the exact
// path the live saver runs — into an offscreen texture, driving multiple scenes on
// the SAME renderer instance to catch scene-switch/state bugs. Writes a PNG per
// scene. Usage: render-real <outDir> [sceneIndex,name ...]
@main
struct RenderReal {
    static func fail(_ m: String) -> Never {
        FileHandle.standardError.write("render-real FAILED: \(m)\n".data(using: .utf8)!); exit(1)
    }
    static func writePNG(_ tex: MTLTexture, _ device: MTLDevice, _ queue: MTLCommandQueue, _ path: String) {
        let W = tex.width, H = tex.height, bpr = W * 4
        var raw = [UInt8](repeating: 0, count: bpr * H)
        tex.getBytes(&raw, bytesPerRow: bpr, from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
        // Texture is BGRA; swizzle to RGBA for the PNG.
        for i in stride(from: 0, to: raw.count, by: 4) { raw.swapAt(i, i + 2) }
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: &raw, width: W, height: H, bitsPerComponent: 8, bytesPerRow: bpr,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let img = ctx.makeImage(),
              let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:])
        else { fail("png \(path)") }
        try? png.write(to: URL(fileURLWithPath: path))
    }

    static func main() {
        let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp"
        // Default: render scene 16 (flux) then 17 (swarm) on the same renderer.
        var scenes: [(Int, String)] = [(16, "flux"), (17, "swarm")]
        if CommandLine.arguments.count > 2 {
            scenes = CommandLine.arguments[2...].compactMap { arg in
                let parts = arg.split(separator: ","); guard parts.count == 2, let i = Int(parts[0]) else { return nil }
                return (i, String(parts[1]))
            }
        }
        let W = 1280, H = 720
        guard let renderer = AuroraRenderer(pixelFormat: .bgra8Unorm),
              let queue = renderer.device.makeCommandQueue() else { fail("renderer init") }

        renderer.setResolution(width: Float(W), height: Float(H))
        let cd = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: W, height: H, mipmapped: false)
        cd.usage = [.renderTarget, .shaderRead]
        guard let target = renderer.device.makeTexture(descriptor: cd) else { fail("target") }

        // Drive settings through the SAME public API the live saver uses (apply +
        // per-scene index in prefs), so nothing about the dispatch is special-cased.
        let prefs = AuroraPreferences()
        prefs.paletteIndex = 0  // Aurora
        prefs.speed = 0.3; prefs.intensity = 1.0; prefs.density = 0.5; prefs.size = 0.85

        for (idx, name) in scenes {
            prefs.sceneIndex = idx
            renderer.apply(preferences: prefs)
            renderer.setTimeForTest(0)
            // Advance ~10 s of frames so each sim develops, through the REAL dispatch.
            for f in 0..<600 {
                renderer.setTimeForTest(Float(f) * (1.0 / 60))
                guard let cmd = queue.makeCommandBuffer() else { fail("cmd") }
                renderer.encodeFrame(into: cmd, target: target)
                cmd.commit(); cmd.waitUntilCompleted()
            }
            writePNG(target, renderer.device, queue, "\(outDir)/real-\(name).png")
            print("wrote \(outDir)/real-\(name).png (scene \(idx))")
        }
    }
}
