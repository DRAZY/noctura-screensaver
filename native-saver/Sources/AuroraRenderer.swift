import Metal
import os
import QuartzCore
import simd

/// Owns the Metal device, pipeline, and per-frame draw for the aurora. Decoupled
/// from the `ScreenSaverView` so the exact same renderer can be exercised by the
/// headless `shader-check` harness (which compiles the pipeline but never shows
/// a window).
///
/// Construction is failable: if Metal is unavailable or the shader fails to
/// compile, `init?` returns nil and the view falls back to a static fill rather
/// than crashing the screensaver host.
final class AuroraRenderer {
    let device: MTLDevice
    private let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let pixelFormat: MTLPixelFormat

    /// The real multi-pass fluid Flux Drift (scene 16). Built lazily the first time
    /// Flux Drift is shown, so users who never select it pay nothing. If it fails to
    /// build, `fluxTried` stays true and the renderer falls back to the per-pixel
    /// `sceneDrift` shader in `aurora_fragment`.
    private var fluxFluid: AuroraFluxFluid?
    private var fluxTried = false
    private static let fluxSceneIndex: Float = 16

    private(set) var uniforms = AuroraUniforms()

    /// Last measured GPU execution time for a single frame, in seconds. Populated
    /// from the command buffer's `gpuEndTime - gpuStartTime` on completion, so it
    /// reflects real GPU cost independent of vsync — the signal the adaptive
    /// performance controller scales against. Stays 0 on hardware/drivers that
    /// don't report GPU timestamps (the controller then falls back to frame-time
    /// overrun detection). Thread-safe: written on the Metal completion thread,
    /// read on the main thread.
    private let gpuFrameTimeLock = OSAllocatedUnfairLock<Double>(initialState: 0)
    var lastGPUFrameTime: Double { gpuFrameTimeLock.withLock { $0 } }

    /// Pick the Metal device to render on. A screensaver is ambient background
    /// work, so we prefer the LOW-POWER (integrated) GPU when the Mac has more
    /// than one: `MTLCreateSystemDefaultDevice()` returns the *discrete* GPU on
    /// dual-GPU Intel MacBook Pros, which forces a GPU switch that keeps the
    /// power-hungry GPU awake the entire time the saver runs — the opposite of
    /// what an idle screensaver wants. Adaptive resolution keeps the integrated
    /// GPU comfortable. Apple Silicon reports a single device, so this is a no-op
    /// there; eGPUs/removable devices are skipped (they can vanish mid-run).
    private static func preferredDevice() -> MTLDevice? {
        let all = MTLCopyAllDevices()
        if all.isEmpty { return MTLCreateSystemDefaultDevice() }
        if let integrated = all.first(where: { $0.isLowPower && !$0.isRemovable }) {
            return integrated
        }
        // No integrated GPU (e.g. Mac Pro): fall back to a non-removable device,
        // else the system default.
        return all.first(where: { !$0.isRemovable }) ?? MTLCreateSystemDefaultDevice()
    }

    /// Build the full pipeline. `pixelFormat` must match the target layer's
    /// `pixelFormat` (CAMetalLayer defaults to `.bgra8Unorm`).
    init?(pixelFormat: MTLPixelFormat = .bgra8Unorm) {
        guard let device = AuroraRenderer.preferredDevice(),
              let queue = device.makeCommandQueue() else {
            return nil
        }
        self.device = device
        self.queue = queue
        self.pixelFormat = pixelFormat

        do {
            let library = try device.makeLibrary(source: AuroraShaderSource.metal, options: nil)
            guard let vfn = library.makeFunction(name: "aurora_vertex"),
                  let ffn = library.makeFunction(name: "aurora_fragment") else {
                return nil
            }
            let desc = MTLRenderPipelineDescriptor()
            desc.vertexFunction = vfn
            desc.fragmentFunction = ffn
            desc.colorAttachments[0].pixelFormat = pixelFormat
            self.pipeline = try device.makeRenderPipelineState(descriptor: desc)
        } catch {
            NSLog("[Aurora] shader/pipeline build failed: \(error)")
            return nil
        }
    }

    /// Apply user settings to the uniform block. Colours come straight from the
    /// chosen palette; the time uniform is advanced separately each frame.
    func apply(preferences: AuroraPreferences) {
        let p = preferences.palette
        uniforms.colorA = p.a
        uniforms.colorB = p.b
        uniforms.colorC = p.c
        uniforms.speed = preferences.speed
        uniforms.intensity = preferences.intensity
        uniforms.density = preferences.density
        uniforms.size = preferences.size
        uniforms.scene = Float(preferences.sceneIndex)
    }

    /// Refresh the polar-clock time uniforms from the current local time. Cheap;
    /// called each frame so the clock scene stays live.
    func updateClock(now: Date = Date()) {
        let cal = Calendar.current
        let c = cal.dateComponents([.second, .minute, .hour, .day, .month, .year, .nanosecond], from: now)
        let sec = (Float(c.second ?? 0) + Float(c.nanosecond ?? 0) / 1_000_000_000) / 60
        let minute = (Float(c.minute ?? 0) + sec) / 60
        let hour = (Float(c.hour ?? 0) + minute) / 24
        let daysInMonth = Float(cal.range(of: .day, in: .month, for: now)?.count ?? 30)
        let day = (Float((c.day ?? 1) - 1) + hour) / daysInMonth
        let month = (Float((c.month ?? 1) - 1) + day) / 12
        uniforms.clock = SIMD4<Float>(sec, minute, hour, day)
        uniforms.month = month
        uniforms.ticks = 1
    }

    func setResolution(width: Float, height: Float) {
        uniforms.resolution = SIMD2<Float>(max(width, 1), max(height, 1))
    }

    func advance(by deltaSeconds: Float) {
        uniforms.time += deltaSeconds
    }

    /// Draw one frame into `layer`'s next drawable. A no-op (returns false) when
    /// no drawable is available — e.g. an offscreen layer with zero size — so
    /// callers never crash on a nil drawable.
    @discardableResult
    func render(to layer: CAMetalLayer) -> Bool {
        guard layer.drawableSize.width > 0, layer.drawableSize.height > 0,
              let drawable = layer.nextDrawable(),
              let cmd = queue.makeCommandBuffer() else {
            return false
        }

        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 1)
        pass.colorAttachments[0].storeAction = .store

        // Flux Drift (scene 16): run the real multi-pass fluid simulation. Built on
        // first use; falls back to the single-pass shader below if it can't build.
        if uniforms.scene == AuroraRenderer.fluxSceneIndex {
            if !fluxTried {
                fluxTried = true
                fluxFluid = AuroraFluxFluid(device: device, drawablePixelFormat: pixelFormat)
            }
            if let flux = fluxFluid {
                flux.encode(into: cmd, target: drawable.texture, uniforms: uniforms)
                cmd.addCompletedHandler { [gpuFrameTimeLock] buffer in
                    let span = buffer.gpuEndTime - buffer.gpuStartTime
                    if span > 0 { gpuFrameTimeLock.withLock { $0 = span } }
                }
                cmd.present(drawable)
                cmd.commit()
                return true
            }
        }

        guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { return false }
        enc.setRenderPipelineState(pipeline)
        var u = uniforms
        enc.setFragmentBytes(&u, length: MemoryLayout<AuroraUniforms>.stride, index: 0)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
        // Record real GPU execution time so the view can adapt resolution/frame
        // rate to the hardware. gpuStartTime/gpuEndTime are valid once the buffer
        // completes; a zero or negative span (unsupported) is simply ignored.
        cmd.addCompletedHandler { [gpuFrameTimeLock] buffer in
            let span = buffer.gpuEndTime - buffer.gpuStartTime
            if span > 0 { gpuFrameTimeLock.withLock { $0 = span } }
        }
        cmd.present(drawable)
        cmd.commit()
        return true
    }
}
