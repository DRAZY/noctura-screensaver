import AppKit
import Metal
import ObjectiveC
import QuartzCore
import ScreenSaver

/// The screensaver principal class. macOS instantiates this via the
/// `NSPrincipalClass` entry in Info.plist; the `@objc(AuroraView)` name keeps
/// that string stable regardless of Swift module mangling.
///
/// Rendering is Metal: a `CAMetalLayer` sublayer driven once per
/// `animateOneFrame()` at 60 Hz. All visual settings come from
/// `AuroraPreferences`, editable through the Options sheet.
@objc(AuroraView)
final class AuroraView: ScreenSaverView {
    private let preferences = AuroraPreferences()
    private let renderer: AuroraRenderer?
    private let metalLayer = CAMetalLayer()
    private var configController: AuroraConfigController?
    // Wall-clock timestamp of the previous frame, so animation advances by real
    // elapsed time rather than a fixed 1/60 — any timer jitter from the
    // screensaver framework then no longer shows up as visible stutter.
    private var lastFrameTime: CFTimeInterval = 0

    // MARK: Adaptive performance (Auto mode) state.
    // The effective render scale Auto is currently using (clamped each frame to
    // [minAdaptiveScale, backingScaleFactor]). Seeded mid-range so it converges
    // quickly from either direction.
    private var adaptiveScale: CGFloat = 1.5
    // Whether Auto is currently targeting 60 fps (vs dropping to 30 when even the
    // lowest resolution can't hold 60).
    private var adaptiveAt60 = true
    // Exponentially smoothed GPU frame time (seconds); 0 until the first sample.
    private var smoothedGPUTime: Double = 0
    // Frames since the last adaptive change — provides hysteresis so the scale
    // doesn't oscillate every frame.
    private var framesSinceAdapt = 0
    // Consecutive slow frames seen when GPU timestamps are unavailable (the
    // frame-time-overrun fallback path).
    private var fallbackSlowFrames = 0

    // Absolute ceiling on rendered pixels along the longest edge, applied in
    // every mode. Keeps pathological panels (6K/8K, spanned displays) from ever
    // dispatching a runaway fragment count even at "Full" — anything larger is
    // rendered at this width and upscaled to fill.
    private let maxRenderEdge: CGFloat = 5120
    // Lower bound on Auto's render scale — below ~native/2 the upscale gets soft.
    private let minAdaptiveScale: CGFloat = 1.0

    override init?(frame: NSRect, isPreview: Bool) {
        renderer = AuroraRenderer(pixelFormat: .bgra8Unorm)
        super.init(frame: frame, isPreview: isPreview)
        commonInit()
    }

    required init?(coder: NSCoder) {
        renderer = AuroraRenderer(pixelFormat: .bgra8Unorm)
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        resetAdaptiveState()
        animationTimeInterval = effectiveFrameInterval()
        wantsLayer = true

        // Black backstop so a failed Metal init (or the first frame before a
        // drawable exists) shows clean black, never garbage.
        layer?.backgroundColor = NSColor.black.cgColor

        if let renderer = renderer {
            metalLayer.device = renderer.device
            metalLayer.pixelFormat = .bgra8Unorm
            metalLayer.framebufferOnly = true
            metalLayer.isOpaque = true
            layer?.addSublayer(metalLayer)
            renderer.apply(preferences: preferences)
        }
        updateLayerGeometry()
    }

    // MARK: - Layout

    override func layout() {
        super.layout()
        updateLayerGeometry()
    }

    override func setFrameSize(_ newSize: NSSize) {
        super.setFrameSize(newSize)
        updateLayerGeometry()
    }

    /// Keep the Metal layer matched to the view's bounds and backing scale so
    /// the image stays crisp on Retina and correct after a resize.
    ///
    /// The drawable's render scale is clamped by the chosen performance profile:
    /// on a Retina/4K/5K panel a full-screen procedural shader pays for every
    /// physical pixel, so capping `drawableSize` below native backing scale is
    /// the single biggest GPU lever. `contentsScale` stays at the true backing
    /// scale, so a smaller drawable is simply upscaled to fill the layer.
    private func updateLayerGeometry() {
        let backing = window?.backingScaleFactor ?? 2.0
        metalLayer.frame = bounds
        metalLayer.contentsScale = backing

        var px = bounds.width * effectiveRenderScale(backing: backing)
        var py = bounds.height * effectiveRenderScale(backing: backing)

        // Absolute backstop: no matter the mode or panel, never render wider than
        // `maxRenderEdge` along the longest side. Protects 6K/8K and spanned
        // displays from a runaway fragment count; the result upscales to fill.
        let longest = max(px, py)
        if longest > maxRenderEdge {
            let k = maxRenderEdge / longest
            px *= k
            py *= k
        }

        let fpx = Float(max(px, 1))
        let fpy = Float(max(py, 1))
        metalLayer.drawableSize = CGSize(width: CGFloat(fpx), height: CGFloat(fpy))
        renderer?.setResolution(width: fpx, height: fpy)
    }

    /// The render scale to use this frame. In Auto mode this is the adaptive
    /// scale the controller has settled on; in a fixed mode it's the profile's
    /// cap. Never exceeds the true backing scale (we don't supersample).
    private func effectiveRenderScale(backing: CGFloat) -> CGFloat {
        let perf = preferences.performance
        let base = perf.isAuto ? adaptiveScale : perf.maxScale
        return min(base, backing)
    }

    /// The frame interval to use. Auto toggles between 60 and 30 fps as a last
    /// resort once resolution is already at the floor; fixed modes use their own.
    private func effectiveFrameInterval() -> TimeInterval {
        let perf = preferences.performance
        if perf.isAuto { return adaptiveAt60 ? 1.0 / 60.0 : 1.0 / 30.0 }
        return perf.frameInterval
    }

    /// Re-seed Auto's adaptive state so it converges fresh each run. Starts a
    /// touch below native and at 60 fps; the controller climbs or backs off from
    /// there based on measured GPU time.
    private func resetAdaptiveState() {
        let backing = window?.backingScaleFactor ?? 2.0
        adaptiveScale = min(1.5, backing)
        adaptiveAt60 = true
        smoothedGPUTime = 0
        framesSinceAdapt = 0
        fallbackSlowFrames = 0
    }

    /// Adjust Auto's render scale / frame rate from measured GPU frame time.
    /// Called once per frame while Auto is active. Uses a target band around the
    /// frame budget with hysteresis: comfortably under → climb toward native;
    /// near the ceiling → trim resolution, then frame rate as a last resort.
    private func adaptPerformanceIfNeeded(dt: Float) {
        guard preferences.performance.isAuto, let renderer = renderer else { return }
        let backing = window?.backingScaleFactor ?? 2.0
        let budget = adaptiveAt60 ? 1.0 / 60.0 : 1.0 / 30.0
        framesSinceAdapt += 1

        let gpu = renderer.lastGPUFrameTime
        if gpu <= 0 {
            // No GPU timestamps: fall back to wall-clock overruns. Only ever
            // *reduce* quality (can't detect spare headroom without a GPU clock).
            if Double(dt) > budget * 1.5 { fallbackSlowFrames += 1 } else { fallbackSlowFrames = 0 }
            if fallbackSlowFrames >= 12, framesSinceAdapt >= 12 {
                stepAdaptiveDown(backing: backing)
                fallbackSlowFrames = 0
                framesSinceAdapt = 0
            }
            return
        }

        // Smooth so a single hitch doesn't yank the scale.
        smoothedGPUTime = smoothedGPUTime == 0 ? gpu : smoothedGPUTime * 0.9 + gpu * 0.1

        // Only re-evaluate periodically so changes settle (and drawableSize isn't
        // thrashed every frame).
        guard framesSinceAdapt >= 30 else { return }

        if smoothedGPUTime > budget * 0.85 {
            stepAdaptiveDown(backing: backing)
            framesSinceAdapt = 0
        } else if smoothedGPUTime < budget * 0.45 {
            stepAdaptiveUp(backing: backing)
            framesSinceAdapt = 0
        }
    }

    /// One step toward lighter: trim resolution first, then drop 60→30 fps once
    /// resolution is already at the floor.
    private func stepAdaptiveDown(backing: CGFloat) {
        let target = max(adaptiveScale * 0.85, minAdaptiveScale)
        if target < adaptiveScale - 0.001 {
            adaptiveScale = target
        } else if adaptiveAt60 {
            adaptiveAt60 = false
            applyFrameInterval()
        } else {
            return // already at the floor on both axes
        }
        smoothedGPUTime = 0 // resolution/rate changed → old samples are stale
        updateLayerGeometry()
    }

    /// One step toward richer: restore 60 fps first, then climb resolution back
    /// toward native.
    private func stepAdaptiveUp(backing: CGFloat) {
        if !adaptiveAt60 {
            adaptiveAt60 = true
            applyFrameInterval()
        } else if adaptiveScale < backing - 0.001 {
            adaptiveScale = min(adaptiveScale * 1.12 + 0.05, backing)
        } else {
            return // already at native 60 fps
        }
        smoothedGPUTime = 0
        updateLayerGeometry()
    }

    /// Push the current effective frame interval to the framework.
    private func applyFrameInterval() {
        animationTimeInterval = effectiveFrameInterval()
    }

    // MARK: - Animation lifecycle

    override func startAnimation() {
        super.startAnimation()
        // Pick up any changes made in the Options sheet since last run, and let
        // Auto reconverge from a clean slate against the current display/GPU.
        resetAdaptiveState()
        animationTimeInterval = effectiveFrameInterval()
        renderer?.apply(preferences: preferences)
        updateLayerGeometry()
        lastFrameTime = 0 // reset so the first frame uses the nominal interval
    }

    override func stopAnimation() {
        super.stopAnimation()
    }

    override func animateOneFrame() {
        // Advance by the real time elapsed since the last frame (clamped so a
        // hitch or paused timer can't jump the animation), which keeps motion
        // smooth even when the framework's frame cadence wobbles.
        let nowT = CACurrentMediaTime()
        var dt = Float(animationTimeInterval)
        if lastFrameTime != 0 {
            dt = Float(min(max(nowT - lastFrameTime, 0), 0.1))
        }
        lastFrameTime = nowT
        renderer?.advance(by: dt)
        renderer?.updateClock() // keep the Polar Clock scene live
        renderer?.render(to: metalLayer)
        // After submitting, fold the last completed frame's GPU time into the
        // Auto controller so resolution/rate track the hardware in real time.
        adaptPerformanceIfNeeded(dt: dt)
    }

    // MARK: - Options sheet

    override var hasConfigureSheet: Bool { true }

    override var configureSheet: NSWindow? {
        // Reuse a single controller/window for the lifetime of this view. Building
        // a fresh NSWindow on every access orphaned the previous one: if its
        // parent↔sheet attachment hadn't fully torn down, the System Settings host
        // would silently refuse to begin a new sheet on its window — the Options
        // panel "wouldn't appear" until Settings was relaunched. One reused window,
        // re-seeded from preferences each time, avoids that stale-attachment trap.
        let controller = configController ?? AuroraConfigController(preferences: preferences) { [weak self] in
            // On dismiss, re-read settings so a still-running preview updates —
            // including the performance profile, which changes both frame cadence
            // and render resolution.
            guard let self else { return }
            self.renderer?.apply(preferences: self.preferences)
            self.resetAdaptiveState() // a mode switch reseeds Auto's convergence
            self.animationTimeInterval = self.effectiveFrameInterval()
            self.updateLayerGeometry()
        }
        configController = controller
        controller.refreshFromPreferences()
        return controller.window
    }
}

/// Builds and drives the programmatic Options sheet — no XIB, so it compiles
/// cleanly under Command Line Tools. Exposes palette, speed, and intensity, the
/// same knobs popular screensavers offer, and persists them through
/// `AuroraPreferences`.
final class AuroraConfigController: NSObject {
    let window: NSWindow
    private let preferences: AuroraPreferences
    private let onClose: () -> Void

    private let scenePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let palettePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let speedSlider = NSSlider()
    private let intensitySlider = NSSlider()
    private let densitySlider = NSSlider()
    private let sizeSlider = NSSlider()
    private let performancePopup = NSPopUpButton(frame: .zero, pullsDown: false)

    init(preferences: AuroraPreferences, onClose: @escaping () -> Void) {
        self.preferences = preferences
        self.onClose = onClose
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 416),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        super.init()
        // CRITICAL: NSWindow defaults isReleasedWhenClosed = true, which fires an
        // extra release on close. ARC already owns this window via the strong
        // `window` property, so that extra release over-releases it and crashes the
        // System Settings / legacyScreenSaver host process — the real cause of
        // "Options won't open until I restart Settings." Disable it.
        window.isReleasedWhenClosed = false
        // Keep this controller alive as long as the window is (the host retains the
        // window while presenting). The buttons' target is a weak reference, so
        // without this the controller could die with a recreated AuroraView and
        // leave the sheet un-dismissable.
        objc_setAssociatedObject(window, &Self.controllerKey, self, .OBJC_ASSOCIATION_RETAIN)
        buildUI()
    }

    private static var controllerKey: UInt8 = 0

    /// Re-seed every control from the persisted preferences. Called each time the
    /// sheet is vended so the reused window never shows stale values.
    func refreshFromPreferences() {
        scenePopup.selectItem(at: preferences.sceneIndex)
        palettePopup.selectItem(at: preferences.paletteIndex)
        speedSlider.doubleValue = Double(preferences.speed)
        intensitySlider.doubleValue = Double(preferences.intensity)
        densitySlider.doubleValue = Double(preferences.density)
        sizeSlider.doubleValue = Double(preferences.size)
        performancePopup.selectItem(at: preferences.performanceIndex)
    }

    private func buildUI() {
        window.title = "Aurora Options"
        let content = NSView(frame: window.contentView!.bounds)
        content.autoresizingMask = [.width, .height]

        func label(_ text: String, _ y: CGFloat) -> NSTextField {
            let l = NSTextField(labelWithString: text)
            l.frame = NSRect(x: 20, y: y, width: 100, height: 20)
            l.alignment = .right
            return l
        }
        func slider(_ s: NSSlider, _ y: CGFloat, _ range: ClosedRange<Float>, _ value: Float) {
            s.frame = NSRect(x: 130, y: y, width: 230, height: 24)
            s.minValue = Double(range.lowerBound)
            s.maxValue = Double(range.upperBound)
            s.doubleValue = Double(value)
        }

        // Scene.
        content.addSubview(label("Scene", 364))
        scenePopup.frame = NSRect(x: 130, y: 360, width: 230, height: 26)
        scenePopup.addItems(withTitles: AuroraScene.all.map { $0.name })
        scenePopup.selectItem(at: preferences.sceneIndex)
        content.addSubview(scenePopup)

        // Style / palette.
        content.addSubview(label("Style", 320))
        palettePopup.frame = NSRect(x: 130, y: 316, width: 230, height: 26)
        palettePopup.addItems(withTitles: AuroraPalette.all.map { $0.name })
        palettePopup.selectItem(at: preferences.paletteIndex)
        content.addSubview(palettePopup)

        content.addSubview(label("Speed", 272))
        slider(speedSlider, 268, AuroraPreferences.speedRange, preferences.speed)
        content.addSubview(speedSlider)

        content.addSubview(label("Intensity", 228))
        slider(intensitySlider, 224, AuroraPreferences.intensityRange, preferences.intensity)
        content.addSubview(intensitySlider)

        content.addSubview(label("Density", 184))
        slider(densitySlider, 180, AuroraPreferences.densityRange, preferences.density)
        content.addSubview(densitySlider)

        // Size — element scale for Matrix Rain glyphs, Fireflies, Caustics.
        content.addSubview(label("Size", 140))
        slider(sizeSlider, 136, AuroraPreferences.sizeRange, preferences.size)
        content.addSubview(sizeSlider)

        // Performance — caps render resolution + frame rate to free up the GPU.
        content.addSubview(label("Performance", 96))
        performancePopup.frame = NSRect(x: 130, y: 92, width: 230, height: 26)
        performancePopup.addItems(withTitles: AuroraPerformance.all.map { $0.name })
        performancePopup.selectItem(at: preferences.performanceIndex)
        content.addSubview(performancePopup)

        // Buttons.
        let cancel = NSButton(title: "Cancel", target: self, action: #selector(cancel))
        cancel.frame = NSRect(x: 150, y: 20, width: 90, height: 30)
        cancel.bezelStyle = .rounded
        cancel.keyEquivalent = "\u{1b}" // Esc
        content.addSubview(cancel)

        let ok = NSButton(title: "OK", target: self, action: #selector(save))
        ok.frame = NSRect(x: 250, y: 20, width: 90, height: 30)
        ok.bezelStyle = .rounded
        ok.keyEquivalent = "\r"
        content.addSubview(ok)

        window.contentView = content
    }

    @objc private func save() {
        preferences.sceneIndex = scenePopup.indexOfSelectedItem
        preferences.paletteIndex = palettePopup.indexOfSelectedItem
        preferences.speed = Float(speedSlider.doubleValue)
        preferences.intensity = Float(intensitySlider.doubleValue)
        preferences.density = Float(densitySlider.doubleValue)
        preferences.size = Float(sizeSlider.doubleValue)
        preferences.performanceIndex = performancePopup.indexOfSelectedItem
        preferences.synchronize()
        dismiss()
    }

    @objc private func cancel() {
        dismiss()
    }

    private func dismiss() {
        onClose()
        // orderOut (not close) so the reused window survives for the next open.
        // End the sheet first if the host attached it as one; otherwise just hide.
        if let parent = window.sheetParent {
            parent.endSheet(window)
        }
        if window.isVisible {
            window.orderOut(nil)
        }
    }
}
