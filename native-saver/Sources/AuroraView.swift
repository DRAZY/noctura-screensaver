import AppKit
import IOKit.ps
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
    // Internal (not private) so the shared config controller can read/write the
    // same persisted settings the live view uses, keeping a single source of truth.
    let preferences = AuroraPreferences()
    private let renderer: AuroraRenderer?
    private let metalLayer = CAMetalLayer()

    // Clock overlay — pure CoreAnimation text layers above the Metal layer, so
    // they stay razor-sharp at any resolution and cost nothing on the GPU
    // (mirrors the WebGL app's DOM overlay). Two layers: time and an optional
    // date line beneath it.
    private let clockTimeLayer = CATextLayer()
    private let clockDateLayer = CATextLayer()
    private let clockTimeFormatter = DateFormatter()
    private let clockDateFormatter = DateFormatter()
    private var lastClockTick = -1
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
    // Lower bound on Auto's render scale. Low enough that even a heavy scene on a
    // weak integrated GPU can reach frame budget by dropping resolution (the image
    // gets soft, but the machine never bogs down — the correct trade for a
    // background screensaver). The panic path below drives toward this fast.
    private let minAdaptiveScale: CGFloat = 0.5

    // MARK: Battery / low-power clamp.
    // A screensaver runs for hours unattended — precisely when nobody is watching
    // the battery — so on battery power (or in macOS Low Power Mode) we cap the
    // effective profile to at most `powerSaveMaxScale` render scale and 30 fps, on
    // top of whatever mode the user picked. Released the moment AC returns. This
    // is the single biggest laptop-battery lever the saver has.
    private var powerSaveActive = false
    private let powerSaveMaxScale: CGFloat = 1.0
    private let powerSaveFrameInterval: TimeInterval = 1.0 / 30.0
    // Run-loop source for IOKit power-source change notifications (AC ⇄ battery).
    private var powerSource: CFRunLoopSource?

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
        configureClockLayers()
        // Battery adaptation is for the LIVE saver only. System Settings spawns
        // throwaway preview instances (and vends the Options sheet from one of
        // them) inside the notoriously fragile `legacyScreenSaver` host; touching
        // IOKit power-source run-loop sources there piles up per-instance state in
        // a process that already leaks views and can leave the Options sheet
        // silently failing to present. A preview thumbnail never needs power
        // management, so we simply never arm it there.
        if !isPreview {
            registerPowerObservers()
            updatePowerState() // seed powerSaveActive before the first frame
        }
        updateLayerGeometry()
    }

    deinit {
        if let src = powerSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), src, .commonModes)
        }
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - Battery / low-power detection

    /// Subscribe to the two events that flip the power-save clamp: an IOKit
    /// power-source change (AC ⇄ battery) and macOS Low Power Mode toggling. Both
    /// funnel into `updatePowerState`, so the clamp is event-driven — no polling.
    private func registerPowerObservers() {
        let ctx = Unmanaged.passUnretained(self).toOpaque()
        if let src = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            Unmanaged<AuroraView>.fromOpaque(context).takeUnretainedValue().updatePowerState()
        }, ctx)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .commonModes)
            powerSource = src
        }
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(powerStateNotification),
            name: NSNotification.Name.NSProcessInfoPowerStateDidChange,
            object: nil
        )
    }

    @objc private func powerStateNotification() { updatePowerState() }

    /// True when the machine is currently drawing from its battery (as opposed to
    /// AC). Reads the live IOKit power-source snapshot; defaults to false (AC) on
    /// desktops or if the snapshot is unavailable.
    private func currentlyOnBattery() -> Bool {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue() else { return false }
        let type = IOPSGetProvidingPowerSourceType(blob).takeRetainedValue() as String
        return type == (kIOPSBatteryPowerValue as String)
    }

    /// Recompute the power-save clamp from battery + Low Power Mode and, if it
    /// changed, reseed the adaptive controller and re-apply cadence + geometry so
    /// the new profile takes effect on the very next frame.
    private func updatePowerState() {
        let save = currentlyOnBattery() || ProcessInfo.processInfo.isLowPowerModeEnabled
        if save == powerSaveActive { return }
        powerSaveActive = save
        resetAdaptiveState()
        if save { adaptiveAt60 = false } // pin the GPU-time budget to the 30 fps cap
        animationTimeInterval = effectiveFrameInterval()
        updateLayerGeometry()
    }

    // MARK: - Clock overlay

    /// One-time setup of the static text-layer properties (color, shadow, etc).
    private func configureClockLayers() {
        clockDateFormatter.dateFormat = "EEEE, MMMM d"
        for l in [clockTimeLayer, clockDateLayer] {
            l.alignmentMode = .center
            l.foregroundColor = NSColor(white: 1.0, alpha: 0.95).cgColor
            l.shadowColor = NSColor.black.cgColor
            l.shadowOpacity = 0.6
            l.shadowRadius = 12
            l.shadowOffset = CGSize(width: 0, height: -2)
            l.isHidden = true
            layer?.addSublayer(l)
        }
    }

    /// The macOS system font for a clock typeface role (matches the app's roles).
    private func clockFont(role: Int, size: CGFloat) -> NSFont {
        switch role {
        case 0: return NSFont.systemFont(ofSize: size, weight: .thin)               // Light
        case 2: return NSFont.systemFont(ofSize: size, weight: .heavy)              // Bold
        case 3: return NSFont.monospacedSystemFont(ofSize: size, weight: .medium)   // Mono
        default: return NSFont.systemFont(ofSize: size, weight: .semibold)          // Modern
        }
    }

    /// Refresh the clock text from the current time. Cheap; called each frame but
    /// only does work when the wall-clock second changes (or when forced after a
    /// settings change). Hides the layers entirely when the mode is Off.
    private func updateClockOverlay(force: Bool = false) {
        let mode = preferences.clockModeIndex
        if mode == 0 {
            if !clockTimeLayer.isHidden || !clockDateLayer.isHidden {
                clockTimeLayer.isHidden = true
                clockDateLayer.isHidden = true
            }
            return
        }
        let now = Date()
        let tick = Int(now.timeIntervalSince1970)
        if !force && tick == lastClockTick { return }
        lastClockTick = tick

        CATransaction.begin()
        CATransaction.setDisableActions(true) // no implicit fade/slide on updates
        clockTimeFormatter.dateFormat = preferences.clock24h ? "HH:mm" : "h:mm a"
        clockTimeLayer.string = clockTimeFormatter.string(from: now)
        let showDate = mode == 2
        clockDateLayer.string = showDate ? clockDateFormatter.string(from: now) : ""
        clockDateLayer.isHidden = !showDate
        clockTimeLayer.isHidden = false
        layoutClockLayers()
        CATransaction.commit()
    }

    /// Position and size the clock layers within the current bounds. Separated
    /// from text refresh so a resize repositions without waiting for the next tick.
    private func layoutClockLayers() {
        guard preferences.clockModeIndex != 0 else { return }
        let backing = window?.backingScaleFactor ?? 2.0
        let b = bounds
        let timeSize = min(max(b.height * 0.12, 28), 240)
        let dateSize = timeSize * 0.20
        let role = preferences.clockFontIndex
        let pos = preferences.clockPositionIndex
        let showDate = preferences.clockModeIndex == 2

        clockTimeLayer.contentsScale = backing
        clockDateLayer.contentsScale = backing
        clockTimeLayer.font = clockFont(role: role, size: timeSize)
        clockTimeLayer.fontSize = timeSize
        clockDateLayer.font = clockFont(role: role, size: dateSize)
        clockDateLayer.fontSize = dateSize

        let align: CATextLayerAlignmentMode = (pos == 3) ? .right : .center
        clockTimeLayer.alignmentMode = align
        clockDateLayer.alignmentMode = align

        let timeH = timeSize * 1.3
        let dateH = dateSize * 1.6
        let gap: CGFloat = 4
        let blockH = timeH + (showDate ? dateH + gap : 0)
        let pad = b.height * 0.06
        let sideInset: CGFloat = (pos == 3) ? b.width * 0.06 : 0
        let layerW = b.width - sideInset * 2

        // Distance of the block's top from the view's top, by position.
        let topGap: CGFloat
        switch pos {
        case 1: topGap = pad                              // Top
        case 2, 3: topGap = b.height - pad - blockH       // Bottom / Corner
        default: topGap = (b.height - blockH) / 2         // Center
        }
        // Layer coords are origin-bottom-left, so frame.y is measured up from the
        // bottom; convert the top-down gaps accordingly.
        clockTimeLayer.frame = CGRect(x: sideInset, y: b.height - topGap - timeH, width: layerW, height: timeH)
        if showDate {
            clockDateLayer.frame = CGRect(x: sideInset, y: b.height - topGap - timeH - gap - dateH, width: layerW, height: dateH)
        }
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
        // Effective drawable px per logical point — Flux Drift derives its
        // screen-space line grid from the logical size via this.
        renderer?.setContentScale(Float(max(px, 1) / max(bounds.width, 1)))
        updateClockOverlay(force: true) // reposition/refresh the clock on resize
    }

    /// The render scale to use this frame. In Auto mode this is the adaptive
    /// scale the controller has settled on; in a fixed mode it's the profile's
    /// cap. Never exceeds the true backing scale (we don't supersample).
    private func effectiveRenderScale(backing: CGFloat) -> CGFloat {
        let perf = preferences.performance
        var base = perf.isAuto ? adaptiveScale : perf.maxScale
        if powerSaveActive { base = min(base, powerSaveMaxScale) } // battery clamp
        return min(base, backing)
    }

    /// The frame interval to use. Auto toggles between 60 and 30 fps as a last
    /// resort once resolution is already at the floor; fixed modes use their own.
    /// On battery / Low Power Mode the result is floored to 30 fps regardless.
    private func effectiveFrameInterval() -> TimeInterval {
        let perf = preferences.performance
        let base = perf.isAuto ? (adaptiveAt60 ? 1.0 / 60.0 : 1.0 / 30.0) : perf.frameInterval
        return powerSaveActive ? max(base, powerSaveFrameInterval) : base
    }

    /// Re-seed Auto's adaptive state so it converges fresh each run. Start at a
    /// SAFE-BUT-VISIBLE middle (≈quarter-native pixels), then climb toward native
    /// when there's headroom. This is deliberately not the full-native start the
    /// old controller used (which let a 605 ms/frame scene peg the GPU for the ~30
    /// frames it took to react); the real safety is the fast panic path in
    /// `adaptPerformanceIfNeeded`, which recovers from any overload in one frame.
    private func resetAdaptiveState() {
        let backing = window?.backingScaleFactor ?? 2.0
        adaptiveScale = min(1.0, backing)
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
            // No GPU timestamps: drive off the wall-clock frame interval instead.
            // Since we now START LOW, this path must also be able to CLIMB when
            // frames are comfortably fast, or a timestamp-less GPU would be stuck
            // soft forever. A very slow frame drops immediately (panic); sustained
            // slow drops gently; sustained fast climbs.
            if Double(dt) > budget * 2.5 {                 // panic: one very slow frame
                stepAdaptiveDown(backing: backing)
                fallbackSlowFrames = 0
                framesSinceAdapt = 0
            } else if Double(dt) > budget * 1.4 {
                fallbackSlowFrames += 1
                if fallbackSlowFrames >= 10 {
                    stepAdaptiveDown(backing: backing)
                    fallbackSlowFrames = 0
                    framesSinceAdapt = 0
                }
            } else {
                fallbackSlowFrames = 0
                if Double(dt) < budget * 0.7, framesSinceAdapt >= 40 {
                    stepAdaptiveUp(backing: backing)  // headroom → climb toward native
                    framesSinceAdapt = 0
                }
            }
            return
        }

        // Smooth so a single hitch doesn't yank the scale.
        smoothedGPUTime = smoothedGPUTime == 0 ? gpu : smoothedGPUTime * 0.9 + gpu * 0.1

        // PANIC PATH: a badly over-budget frame is fixed IMMEDIATELY, not after the
        // 30-frame hysteresis window. GPU cost scales with pixel count (≈ scale²),
        // so we jump straight to the scale that would hit ~80% of budget in a
        // single step, instead of nibbling 15% at a time (which left the old
        // controller pegged for seconds recovering from a heavy scene). Uses the
        // raw frame time, not the smoothed value, so it reacts on the first bad
        // frame after startup.
        if gpu > budget * 1.6 {
            let ratio = (budget * 0.8) / gpu               // <1
            let target = max(adaptiveScale * CGFloat(sqrt(ratio)), minAdaptiveScale)
            if target < adaptiveScale - 0.01 {
                adaptiveScale = target
                smoothedGPUTime = 0
                framesSinceAdapt = 0
                updateLayerGeometry()
                return
            }
            // Already at the resolution floor and still slow → shed frame rate.
            if adaptiveAt60 {
                adaptiveAt60 = false
                applyFrameInterval()
                smoothedGPUTime = 0
                framesSinceAdapt = 0
            }
            return
        }

        // Only re-evaluate periodically so gentle changes settle (and drawableSize
        // isn't thrashed every frame).
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
        // Auto reconverge from a clean slate against the current display/GPU and
        // the live power source.
        powerSaveActive = currentlyOnBattery() || ProcessInfo.processInfo.isLowPowerModeEnabled
        resetAdaptiveState()
        if powerSaveActive { adaptiveAt60 = false } // pin the GPU-time budget to 30 fps
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
        updateClockOverlay() // throttled to once per wall-clock second
    }

    // MARK: - Options sheet

    override var hasConfigureSheet: Bool { true }

    override var configureSheet: NSWindow? {
        // Build a BRAND-NEW controller + window every call, and tie the
        // controller's lifetime to that window (associated object) — NOT to any
        // process-wide static. This is the crux of the long-standing "Options does
        // nothing after clicking Done / switching scenes" bug:
        //
        //   * A reused window carries residual sheet/visibility state that
        //     entangles with System Settings' own sheet bookkeeping; once they
        //     disagree the host silently refuses beginSheet until Settings is
        //     relaunched.
        //   * A persistent static controller keeps stale state alive across the
        //     host tearing down and recreating the preview view (which is exactly
        //     what "Done" then reopening does), so the next present starts dirty.
        //
        // Tying the controller to the window means: the host retains the window
        // for the duration of its sheet, the controller lives exactly that long,
        // and when the host drops the window BOTH are released. Zero global state
        // survives between presentations, so every Options click starts pristine.
        let controller = AuroraConfigController(view: self)
        objc_setAssociatedObject(controller.window, &AuroraConfigController.assocKey,
                                 controller, .OBJC_ASSOCIATION_RETAIN)
        return controller.window
    }

    /// Re-read settings after the Options sheet closes so a still-running preview
    /// updates live — including the performance profile, which changes both frame
    /// cadence and render resolution. Called by the shared config controller on
    /// the view that vended the sheet.
    func reloadFromPreferences() {
        renderer?.apply(preferences: preferences)
        resetAdaptiveState() // a mode switch reseeds Auto's convergence
        if powerSaveActive { adaptiveAt60 = false } // keep the 30 fps cap on battery
        animationTimeInterval = effectiveFrameInterval()
        updateLayerGeometry()
        updateClockOverlay(force: true) // apply clock setting changes live
    }
}

/// Builds and drives the programmatic Options sheet — no XIB, so it compiles
/// cleanly under Command Line Tools. Exposes palette, speed, and intensity, the
/// same knobs popular screensavers offer, and persists them through
/// `AuroraPreferences`.
final class AuroraConfigController: NSObject {
    /// Key for the objc associated object that ties a controller's lifetime to
    /// its window. No value; only its address is used as the association key.
    static var assocKey: UInt8 = 0

    let window: NSWindow
    /// The view that vended this sheet; settings are read/written through it so
    /// preview and saver stay in sync. Weak so a recreated view can deallocate.
    private weak var currentView: AuroraView?

    private let scenePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let palettePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let speedSlider = NSSlider()
    private let intensitySlider = NSSlider()
    private let densitySlider = NSSlider()
    private let sizeSlider = NSSlider()
    private let performancePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clockModePopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clockFontPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clockPositionPopup = NSPopUpButton(frame: .zero, pullsDown: false)
    private let clock24hCheckbox = NSButton(checkboxWithTitle: "24-hour clock", target: nil, action: nil)

    /// Build a fresh Options window bound to `view` and seed its controls. Every
    /// present gets one of these — never a reused window. The window retains this
    /// controller via an associated object (set by the caller), so the controller
    /// lives exactly as long as the window and dies when the host releases it.
    init(view: AuroraView) {
        self.currentView = view
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 604),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        super.init()
        // Keep release-on-close off so our explicit close() in dismiss() only
        // ends the presentation; the associated object then drops the last strong
        // reference and ARC deallocates both window and controller together.
        window.isReleasedWhenClosed = false
        buildUI()
        refreshFromPreferences()
    }

    private var preferences: AuroraPreferences? { currentView?.preferences }

    /// Seed every control from the persisted preferences. Called once at build,
    /// on this controller's fresh window.
    func refreshFromPreferences() {
        guard let preferences else { return }
        scenePopup.selectItem(at: preferences.sceneIndex)
        palettePopup.selectItem(at: preferences.paletteIndex)
        speedSlider.doubleValue = Double(preferences.speed)
        intensitySlider.doubleValue = Double(preferences.intensity)
        densitySlider.doubleValue = Double(preferences.density)
        sizeSlider.doubleValue = Double(preferences.size)
        performancePopup.selectItem(at: preferences.performanceIndex)
        clockModePopup.selectItem(at: preferences.clockModeIndex)
        clockFontPopup.selectItem(at: preferences.clockFontIndex)
        clockPositionPopup.selectItem(at: preferences.clockPositionIndex)
        clock24hCheckbox.state = preferences.clock24h ? .on : .off
    }

    private func buildUI() {
        window.title = "Noctura Options"
        let content = NSView(frame: window.contentView!.bounds)
        content.autoresizingMask = [.width, .height]

        // Controls are laid out top-down with a running y cursor so the list is
        // easy to extend. Values are seeded by refreshFromPreferences() in init.
        var y: CGFloat = 558
        let step: CGFloat = 44

        func label(_ text: String) -> NSTextField {
            let l = NSTextField(labelWithString: text)
            l.frame = NSRect(x: 20, y: y, width: 100, height: 20)
            l.alignment = .right
            return l
        }
        func popup(_ p: NSPopUpButton, _ titles: [String]) {
            p.frame = NSRect(x: 130, y: y - 4, width: 230, height: 26)
            p.removeAllItems()
            p.addItems(withTitles: titles)
            content.addSubview(p)
        }
        func slider(_ s: NSSlider, _ range: ClosedRange<Float>) {
            s.frame = NSRect(x: 130, y: y - 4, width: 230, height: 24)
            s.minValue = Double(range.lowerBound)
            s.maxValue = Double(range.upperBound)
            content.addSubview(s)
        }

        content.addSubview(label("Scene")); popup(scenePopup, AuroraScene.all.map { $0.name }); y -= step
        content.addSubview(label("Style")); popup(palettePopup, AuroraPalette.all.map { $0.name }); y -= step
        content.addSubview(label("Speed")); slider(speedSlider, AuroraPreferences.speedRange); y -= step
        content.addSubview(label("Intensity")); slider(intensitySlider, AuroraPreferences.intensityRange); y -= step
        content.addSubview(label("Density")); slider(densitySlider, AuroraPreferences.densityRange); y -= step
        content.addSubview(label("Size")); slider(sizeSlider, AuroraPreferences.sizeRange); y -= step
        content.addSubview(label("Performance")); popup(performancePopup, AuroraPerformance.all.map { $0.name }); y -= step
        // Clock overlay controls.
        content.addSubview(label("Clock")); popup(clockModePopup, AuroraClock.modes); y -= step
        content.addSubview(label("Font")); popup(clockFontPopup, AuroraClock.fonts); y -= step
        content.addSubview(label("Position")); popup(clockPositionPopup, AuroraClock.positions); y -= step
        clock24hCheckbox.frame = NSRect(x: 130, y: y, width: 230, height: 22)
        content.addSubview(clock24hCheckbox)

        // Lock-on-resume guidance. A sandboxed screensaver cannot make macOS
        // require a password — that's an OS-owned setting. Rather than a button
        // that can't deliver it, tell the user exactly where to enable it; once
        // set, macOS locks automatically the moment the screensaver starts.
        let lockInfo = NSTextField(wrappingLabelWithString:
            "Lock on wake is a macOS setting: System Settings → Lock Screen → "
            + "\u{201C}Require password after screen saver begins\u{201D} → Immediately.")
        lockInfo.frame = NSRect(x: 20, y: 50, width: 340, height: 46)
        lockInfo.font = NSFont.systemFont(ofSize: 11)
        lockInfo.textColor = .secondaryLabelColor
        content.addSubview(lockInfo)

        // Buttons pinned to the bottom.
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
        if let preferences {
            preferences.sceneIndex = scenePopup.indexOfSelectedItem
            preferences.paletteIndex = palettePopup.indexOfSelectedItem
            preferences.speed = Float(speedSlider.doubleValue)
            preferences.intensity = Float(intensitySlider.doubleValue)
            preferences.density = Float(densitySlider.doubleValue)
            preferences.size = Float(sizeSlider.doubleValue)
            preferences.performanceIndex = performancePopup.indexOfSelectedItem
            preferences.clockModeIndex = clockModePopup.indexOfSelectedItem
            preferences.clockFontIndex = clockFontPopup.indexOfSelectedItem
            preferences.clockPositionIndex = clockPositionPopup.indexOfSelectedItem
            preferences.clock24h = (clock24hCheckbox.state == .on)
            preferences.synchronize()
        }
        dismiss()
    }

    @objc private func cancel() {
        dismiss()
    }

    private func dismiss() {
        // End the sheet so the host drops the window, let the live view re-read
        // settings, then release ourselves by clearing the associated object.
        // Deferred to the next runloop tick so `self` (this button-action target)
        // isn't deallocated while this method is still on the stack.
        let win = window
        let view = currentView
        if let parent = win.sheetParent {
            parent.endSheet(win)
        }
        win.orderOut(nil)
        view?.reloadFromPreferences()
        DispatchQueue.main.async {
            // Drops the last strong reference (the associated object) → ARC frees
            // this controller and its window together. Nothing persists to go stale.
            objc_setAssociatedObject(win, &AuroraConfigController.assocKey, nil, .OBJC_ASSOCIATION_RETAIN)
            win.close()
        }
    }
}
