import Foundation
import AppKit
import ScreenSaver

// Loads a built .saver exactly the way the macOS screensaver host does:
// NSBundle → principalClass → ScreenSaverView subclass → instantiate. This
// exercises the real bundle (Metal renderer construction, runtime shader
// compile, layer setup) headlessly. Visual output still requires selecting the
// saver in System Settings, but a clean load + instantiation rules out the
// common failure modes (unresolved principal class, init crash, bad plist).
@main
struct VerifyLoad {
    static func fail(_ msg: String) -> Never {
        FileHandle.standardError.write("load-check FAILED: \(msg)\n".data(using: .utf8)!)
        exit(1)
    }

    static func main() {
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)

        guard CommandLine.arguments.count > 1 else { fail("usage: verify-load <path-to-.saver>") }
        let path = CommandLine.arguments[1]

        guard let bundle = Bundle(path: path) else { fail("cannot open bundle at \(path)") }
        guard bundle.load() else { fail("bundle.load() returned false") }
        guard let cls = bundle.principalClass else { fail("no principalClass (check NSPrincipalClass)") }
        guard let saverType = cls as? ScreenSaverView.Type else {
            fail("principalClass \(cls) is not a ScreenSaverView subclass")
        }
        let rect = NSRect(x: 0, y: 0, width: 640, height: 480)
        guard let view = saverType.init(frame: rect, isPreview: false) else {
            fail("init(frame:isPreview:) returned nil")
        }
        view.startAnimation()
        view.animateOneFrame()
        view.stopAnimation()

        // Options sheet path. System Settings instantiates the saver in PREVIEW
        // mode and vends its Options window via `configureSheet` — repeatedly, as
        // it recreates the preview on every reselection. Exercise that exact path:
        // a preview instance must construct, report hasConfigureSheet, and return a
        // populated window twice in a row (the reuse/stale-state trap).
        guard let preview = saverType.init(frame: rect, isPreview: true) else {
            fail("preview init(frame:isPreview:true) returned nil")
        }
        guard preview.hasConfigureSheet else { fail("hasConfigureSheet is false") }
        for attempt in 1...2 {
            guard let sheet = preview.configureSheet else {
                fail("configureSheet returned nil on attempt \(attempt)")
            }
            guard let content = sheet.contentView, !content.subviews.isEmpty else {
                fail("configureSheet window has no populated contentView on attempt \(attempt)")
            }
        }
        print("load-check OK: principalClass=\(cls), ScreenSaverView=true, instantiated=true, "
            + "hasConfigureSheet=\(view.hasConfigureSheet), configureSheet=populated(x2)")
        exit(0)
    }
}
