import Metal
import Foundation

// Headless verification that the aurora MSL compiles and links into a render
// pipeline on this machine's GPU — the single highest-risk part of the native
// saver, validated without ever opening a window. Compiled and run by build.sh.
// Exits 0 on success, 1 on any failure with a diagnostic on stderr.
@main
struct ShaderCheck {
    static func main() {
        guard let device = MTLCreateSystemDefaultDevice() else {
            FileHandle.standardError.write("no Metal device available\n".data(using: .utf8)!)
            exit(1)
        }

        do {
            let library = try device.makeLibrary(source: AuroraShaderSource.metal, options: nil)
            guard let vfn = library.makeFunction(name: "aurora_vertex") else {
                throw NSError(domain: "aurora", code: 2,
                              userInfo: [NSLocalizedDescriptionKey: "missing aurora_vertex"])
            }
            guard let ffn = library.makeFunction(name: "aurora_fragment") else {
                throw NSError(domain: "aurora", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "missing aurora_fragment"])
            }
            let desc = MTLRenderPipelineDescriptor()
            desc.vertexFunction = vfn
            desc.fragmentFunction = ffn
            desc.colorAttachments[0].pixelFormat = .bgra8Unorm
            _ = try device.makeRenderPipelineState(descriptor: desc)

            // Sanity-check the CPU/GPU uniform layout assumption.
            let stride = MemoryLayout<AuroraUniforms>.stride
            if stride < 80 {
                throw NSError(domain: "aurora", code: 4,
                              userInfo: [NSLocalizedDescriptionKey: "unexpected AuroraUniforms stride \(stride)"])
            }
            // Flux Drift's multi-pass fluid MSL compiles at runtime via
            // makeLibrary(source:), so a syntax error there wouldn't fail the Swift
            // build — instantiate the whole fluid pipeline here to catch it. This
            // builds all 10 fluid/line pipelines + textures on the real GPU.
            guard AuroraFluxFluid(device: device, drawablePixelFormat: .bgra8Unorm) != nil else {
                throw NSError(domain: "aurora", code: 5,
                              userInfo: [NSLocalizedDescriptionKey: "Flux fluid pipeline failed to build"])
            }
            print("shader-check OK on \(device.name): pipeline built, uniforms stride=\(stride), flux fluid OK")
            exit(0)
        } catch {
            FileHandle.standardError.write("shader-check FAILED: \(error)\n".data(using: .utf8)!)
            exit(1)
        }
    }
}
