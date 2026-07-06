import Metal
import AppKit
import Foundation
import simd

// Headless capture of the multi-pass fluid Flux Drift: builds AuroraFluxFluid,
// advances the sim over many frames into an offscreen texture, and writes a PNG.
// Also prints the GPU time of the last frame so we can confirm it stays in budget.
// Usage: flux-capture [outPath] [frames]
@main
struct FluxCapture {
    static func fail(_ m: String) -> Never {
        FileHandle.standardError.write("flux-capture FAILED: \(m)\n".data(using: .utf8)!)
        exit(1)
    }
    static func main() {
        let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/flux-native.png"
        let frames = CommandLine.arguments.count > 2 ? Int(CommandLine.arguments[2]) ?? 90 : 90
        let W = 1280, H = 720

        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fail("no Metal device") }
        guard let flux = AuroraFluxFluid(device: device, drawablePixelFormat: .rgba8Unorm) else { fail("fluid build") }

        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: W, height: H, mipmapped: false)
        td.usage = [.renderTarget, .shaderRead]
        guard let target = device.makeTexture(descriptor: td) else { fail("target texture") }

        var u = AuroraUniforms()
        u.scene = 16
        u.resolution = SIMD2<Float>(Float(W), Float(H))
        u.speed = 0.3; u.intensity = 1.0; u.density = 0.5; u.size = 0.85
        // Aurora palette (index 0) sRGB-ish stops.
        u.colorA = SIMD4<Float>(0.10, 0.07, 0.25, 1)
        u.colorB = SIMD4<Float>(0.784, 0.118, 0.541, 1)
        u.colorC = SIMD4<Float>(0.961, 0.651, 0.137, 1)

        var lastGPU = 0.0
        // Advance real time by 1/60 each frame so the fixed-timestep accumulator ticks.
        for f in 0..<frames {
            u.time = Float(f) * (1.0 / 60)
            guard let cmd = queue.makeCommandBuffer() else { fail("cmd") }
            flux.encode(into: cmd, target: target, uniforms: u)
            cmd.addCompletedHandler { b in lastGPU = b.gpuEndTime - b.gpuStartTime }
            cmd.commit()
            cmd.waitUntilCompleted()
            _ = f
        }

        // Read back RGBA → PNG.
        let bpr = W * 4
        var raw = [UInt8](repeating: 0, count: bpr * H)
        target.getBytes(&raw, bytesPerRow: bpr, from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: &raw, width: W, height: H, bitsPerComponent: 8, bytesPerRow: bpr,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let img = ctx.makeImage() else { fail("cgimage") }
        let rep = NSBitmapImageRep(cgImage: img)
        guard let png = rep.representation(using: .png, properties: [:]) else { fail("png") }
        try? png.write(to: URL(fileURLWithPath: out))
        print(String(format: "flux-capture OK: %@ (%d frames, last GPU %.2f ms)", out, frames, lastGPU * 1000))
    }
}
