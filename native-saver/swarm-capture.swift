import Metal
import AppKit
import Foundation
import simd

// Headless capture of the Particle Swarm point cloud → PNG, for visual verification.
// Usage: swarm-capture [outPath]
@main
struct SwarmCapture {
    static func fail(_ m: String) -> Never {
        FileHandle.standardError.write("swarm-capture FAILED: \(m)\n".data(using: .utf8)!)
        exit(1)
    }
    static func main() {
        let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/swarm-native.png"
        let W = 1280, H = 720
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { fail("no Metal device") }
        guard let swarm = AuroraParticleSwarm(device: device, drawablePixelFormat: .rgba8Unorm) else { fail("swarm build") }
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: W, height: H, mipmapped: false)
        td.usage = [.renderTarget, .shaderRead]
        guard let target = device.makeTexture(descriptor: td) else { fail("target") }

        var u = AuroraUniforms()
        u.scene = 17
        u.resolution = SIMD2<Float>(Float(W), Float(H))
        u.speed = 0.3; u.intensity = 1.0; u.density = 0.5; u.size = 0.85
        u.colorA = SIMD4<Float>(0.10, 0.07, 0.25, 1)
        u.colorB = SIMD4<Float>(0.784, 0.118, 0.541, 1)  // palette .b
        u.colorC = SIMD4<Float>(0.961, 0.651, 0.137, 1)  // palette .c
        u.time = 4.0  // a few seconds in so the flow has developed

        guard let cmd = queue.makeCommandBuffer() else { fail("cmd") }
        swarm.encode(into: cmd, target: target, uniforms: u)
        var gpu = 0.0
        cmd.addCompletedHandler { b in gpu = b.gpuEndTime - b.gpuStartTime }
        cmd.commit(); cmd.waitUntilCompleted()

        let bpr = W * 4
        var raw = [UInt8](repeating: 0, count: bpr * H)
        target.getBytes(&raw, bytesPerRow: bpr, from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
        guard let cs = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: &raw, width: W, height: H, bitsPerComponent: 8, bytesPerRow: bpr,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
              let img = ctx.makeImage() else { fail("cgimage") }
        guard let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else { fail("png") }
        try? png.write(to: URL(fileURLWithPath: out))
        print(String(format: "swarm-capture OK: %@ (GPU %.2f ms)", out, gpu * 1000))
    }
}
