import Foundation
import ScreenSaver
import simd

/// Bundle identifier used to scope `ScreenSaverDefaults`. Must match
/// `CFBundleIdentifier` in Info.plist.
let kAuroraModuleName = "com.aurora.screensaver"

/// The scenes the saver can display — mirrors the shader's `u.scene` branch
/// order and the WebGL gallery.
struct AuroraScene {
    let name: String
    static let all: [AuroraScene] = [
        AuroraScene(name: "Aurora Drift"),
        AuroraScene(name: "Northern Lights"),
        AuroraScene(name: "Deep Space"),
        AuroraScene(name: "Particle Drift"),
        AuroraScene(name: "Plasma Field"),
        AuroraScene(name: "Matrix Rain"),
        AuroraScene(name: "Fireflies"),
        AuroraScene(name: "Black Hole"),
        AuroraScene(name: "Hyperspace Tunnel"),
        AuroraScene(name: "Synthwave"),
        AuroraScene(name: "Kaleidoscope"),
        AuroraScene(name: "Caustics"),
        AuroraScene(name: "Polar Clock"),
    ]
}

/// A performance profile: caps the Metal drawable's render scale (the #1 GPU
/// driver on Retina/4K/5K panels — a full-screen procedural shader pays per
/// physical pixel) and the animation frame interval.
///
/// `Auto` is the default and the one most people should leave on: it measures
/// real GPU frame time and continuously trims resolution (and, if still
/// strained, frame rate) to stay light on *whatever* hardware it runs on, then
/// climbs back toward native when there's headroom. The fixed modes are manual
/// overrides — `Full` pins native-resolution 60 fps; the lighter two trade a
/// little sharpness for guaranteed GPU headroom. For `Auto`, `maxScale` and
/// `frameInterval` act as the ceiling the adaptive controller may climb to.
struct AuroraPerformance {
    let name: String
    /// Upper bound on the backing scale used for `drawableSize`. The effective
    /// scale is `min(window.backingScaleFactor, maxScale)`, so this only ever
    /// *reduces* resolution — it never upsamples beyond native.
    let maxScale: CGFloat
    let frameInterval: TimeInterval
    /// When true, the view drives resolution/frame-rate dynamically from
    /// measured GPU time instead of using the fixed `maxScale`/`frameInterval`.
    let isAuto: Bool
    static let all: [AuroraPerformance] = [
        AuroraPerformance(name: "Auto (adaptive)",      maxScale: 2.0, frameInterval: 1.0 / 60.0, isAuto: true),
        AuroraPerformance(name: "Full (60 fps)",        maxScale: 2.0, frameInterval: 1.0 / 60.0, isAuto: false),
        AuroraPerformance(name: "Balanced (60 fps)",    maxScale: 1.5, frameInterval: 1.0 / 60.0, isAuto: false),
        AuroraPerformance(name: "Power Saver (30 fps)", maxScale: 1.0, frameInterval: 1.0 / 30.0, isAuto: false),
    ]
}

/// A named color palette (three stops the scenes blend between).
struct AuroraPalette {
    let name: String
    let a: SIMD4<Float>
    let b: SIMD4<Float>
    let c: SIMD4<Float>
    static func rgb(_ r: Float, _ g: Float, _ b: Float) -> SIMD4<Float> { SIMD4<Float>(r, g, b, 1) }

    static let all: [AuroraPalette] = [
        AuroraPalette(name: "Aurora",     a: rgb(0.102,0.071,0.251), b: rgb(0.784,0.118,0.541), c: rgb(0.961,0.651,0.137)),
        AuroraPalette(name: "Borealis",   a: rgb(0.020,0.090,0.130), b: rgb(0.075,0.760,0.520), c: rgb(0.620,0.950,0.420)),
        AuroraPalette(name: "Deep Space", a: rgb(0.008,0.012,0.039), b: rgb(0.227,0.184,0.561), c: rgb(0.812,0.878,1.000)),
        AuroraPalette(name: "Ocean",      a: rgb(0.012,0.055,0.180), b: rgb(0.047,0.361,0.639), c: rgb(0.420,0.824,0.878)),
        AuroraPalette(name: "Ember",      a: rgb(0.110,0.020,0.012), b: rgb(0.780,0.231,0.039), c: rgb(0.980,0.816,0.263)),
        AuroraPalette(name: "Synthwave",  a: rgb(0.090,0.008,0.188), b: rgb(0.851,0.110,0.561), c: rgb(0.180,0.760,0.922)),
        AuroraPalette(name: "Sunset",     a: rgb(0.141,0.063,0.137), b: rgb(0.910,0.353,0.420), c: rgb(1.000,0.808,0.420)),
        AuroraPalette(name: "Nebula",     a: rgb(0.039,0.016,0.094), b: rgb(0.482,0.184,0.969), c: rgb(0.969,0.435,0.831)),
        AuroraPalette(name: "Mint",       a: rgb(0.016,0.078,0.059), b: rgb(0.122,0.722,0.573), c: rgb(0.788,1.000,0.910)),
        AuroraPalette(name: "Gold",       a: rgb(0.078,0.051,0.008), b: rgb(0.690,0.490,0.102), c: rgb(1.000,0.914,0.659)),
        AuroraPalette(name: "Ice",        a: rgb(0.016,0.039,0.078), b: rgb(0.231,0.435,0.682), c: rgb(0.914,0.965,1.000)),
        AuroraPalette(name: "Rose",       a: rgb(0.110,0.024,0.063), b: rgb(0.839,0.200,0.424), c: rgb(1.000,0.851,0.761)),
        AuroraPalette(name: "Monochrome", a: rgb(0.020,0.020,0.025), b: rgb(0.380,0.400,0.440), c: rgb(0.918,0.937,0.961)),
    ]
}

/// Typed, persisted settings shared between preview, live saver, and Options sheet.
final class AuroraPreferences {
    private let defaults: ScreenSaverDefaults

    private let kScene = "sceneIndex"
    private let kPalette = "paletteIndex"
    private let kSpeed = "speed"
    private let kIntensity = "intensity"
    private let kDensity = "density"
    private let kSize = "size"
    private let kPerformance = "performanceIndex"

    static let speedRange: ClosedRange<Float> = 0.03...1.2
    static let intensityRange: ClosedRange<Float> = 0.0...1.5
    static let densityRange: ClosedRange<Float> = 0.0...1.0
    static let sizeRange: ClosedRange<Float> = 0.4...2.2

    init() {
        defaults = ScreenSaverDefaults(forModuleWithName: kAuroraModuleName)!
        defaults.register(defaults: [
            kScene: 0, kPalette: 0, kSpeed: 0.3, kIntensity: 1.0, kDensity: 0.5, kSize: 0.85,
            kPerformance: 0,
        ])
    }

    var sceneIndex: Int {
        get { clampInt(defaults.integer(forKey: kScene), 0, AuroraScene.all.count - 1) }
        set { defaults.set(newValue, forKey: kScene) }
    }
    var paletteIndex: Int {
        get { clampInt(defaults.integer(forKey: kPalette), 0, AuroraPalette.all.count - 1) }
        set { defaults.set(newValue, forKey: kPalette) }
    }
    var speed: Float {
        get { clampF(Float(defaults.double(forKey: kSpeed)), AuroraPreferences.speedRange) }
        set { defaults.set(Double(clampF(newValue, AuroraPreferences.speedRange)), forKey: kSpeed) }
    }
    var intensity: Float {
        get { clampF(Float(defaults.double(forKey: kIntensity)), AuroraPreferences.intensityRange) }
        set { defaults.set(Double(clampF(newValue, AuroraPreferences.intensityRange)), forKey: kIntensity) }
    }
    var density: Float {
        get { clampF(Float(defaults.double(forKey: kDensity)), AuroraPreferences.densityRange) }
        set { defaults.set(Double(clampF(newValue, AuroraPreferences.densityRange)), forKey: kDensity) }
    }
    var size: Float {
        get { clampF(Float(defaults.double(forKey: kSize)), AuroraPreferences.sizeRange) }
        set { defaults.set(Double(clampF(newValue, AuroraPreferences.sizeRange)), forKey: kSize) }
    }

    var performanceIndex: Int {
        get { clampInt(defaults.integer(forKey: kPerformance), 0, AuroraPerformance.all.count - 1) }
        set { defaults.set(newValue, forKey: kPerformance) }
    }

    var palette: AuroraPalette { AuroraPalette.all[paletteIndex] }
    var performance: AuroraPerformance { AuroraPerformance.all[performanceIndex] }

    func synchronize() { defaults.synchronize() }
}

private func clampF(_ v: Float, _ r: ClosedRange<Float>) -> Float { min(max(v, r.lowerBound), r.upperBound) }
private func clampInt(_ v: Int, _ lo: Int, _ hi: Int) -> Int { min(max(v, lo), hi) }
