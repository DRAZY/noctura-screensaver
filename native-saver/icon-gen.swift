import Metal
import AppKit
import Foundation
import simd

// Renders the Aurora Drift scene at 1024×1024 to a PNG for use as the app icon
// (`bun run tauri icon <png>`). Reuses the saver's MSL so the brand mark matches
// the actual scene.
@main
struct IconGen {
    static func main() {
        let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/aurora-icon.png"
        guard let device = MTLCreateSystemDefaultDevice(),
              let queue = device.makeCommandQueue() else { exit(1) }
        let lib = try! device.makeLibrary(source: AuroraShaderSource.metal, options: nil)
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = lib.makeFunction(name: "aurora_vertex")
        d.fragmentFunction = lib.makeFunction(name: "aurora_fragment")
        d.colorAttachments[0].pixelFormat = .rgba8Unorm
        let pipeline = try! device.makeRenderPipelineState(descriptor: d)

        let S = 1024
        let td = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba8Unorm, width: S, height: S, mipmapped: false)
        td.usage = [.renderTarget, .shaderRead]; td.storageMode = .shared
        let tex = device.makeTexture(descriptor: td)!

        var u = AuroraUniforms()
        u.scene = 0; u.time = 6.0; u.speed = 0.4; u.intensity = 1.1
        u.resolution = SIMD2<Float>(Float(S), Float(S))
        let p = AuroraPalette.all[0]
        u.colorA = p.a; u.colorB = p.b; u.colorC = p.c

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = tex
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].storeAction = .store
        let cmd = queue.makeCommandBuffer()!
        let enc = cmd.makeRenderCommandEncoder(descriptor: pass)!
        enc.setRenderPipelineState(pipeline)
        enc.setFragmentBytes(&u, length: MemoryLayout<AuroraUniforms>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding(); cmd.commit(); cmd.waitUntilCompleted()

        let bpr = S * 4
        var raw = [UInt8](repeating: 0, count: bpr * S)
        tex.getBytes(&raw, bytesPerRow: bpr, from: MTLRegionMake2D(0, 0, S, S), mipmapLevel: 0)
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: S, pixelsHigh: S,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: bpr, bitsPerPixel: 32)!
        memcpy(rep.bitmapData!, raw, raw.count)
        try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
        print("wrote \(out)")
        exit(0)
    }
}
