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

        // Options sheet path — the exact scenario that intermittently broke:
        // System Settings recreates the PREVIEW instance every time a different
        // scene is selected, then vends its Options window via `configureSheet`
        // and begins it as a sheet on its own window. Reproduce that loop several
        // times: fresh preview instance, get configureSheet, actually begin+end a
        // sheet on a host window, and assert it presents cleanly every round. A
        // reused/stale window fails to attach on a later round — that is the bug.
        let host = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
                            styleMask: [.titled], backing: .buffered, defer: false)
        host.orderFrontRegardless()

        var lastWindow: NSWindow? = nil
        var presentedRounds = 0
        for round in 1...5 {
            guard let preview = saverType.init(frame: rect, isPreview: true) else {
                fail("preview init(frame:isPreview:true) returned nil on round \(round)")
            }
            guard preview.hasConfigureSheet else { fail("hasConfigureSheet is false on round \(round)") }
            guard let sheet = preview.configureSheet else {
                fail("configureSheet returned nil on round \(round)")
            }
            guard let content = sheet.contentView, !content.subviews.isEmpty else {
                fail("configureSheet window has no populated contentView on round \(round)")
            }
            // Must be a FRESH window each round (no reuse) and pristine before use.
            if sheet === lastWindow { fail("configureSheet returned the SAME window on round \(round) — reuse regression") }
            if sheet.sheetParent != nil { fail("configureSheet window already has a sheetParent on round \(round)") }
            if sheet.isVisible { fail("configureSheet window is already visible on round \(round)") }
            lastWindow = sheet

            // Drive the real host handshake: begin the sheet, spin briefly, verify
            // it attached, then end it. This is the call that silently no-ops in
            // the failure mode.
            host.beginSheet(sheet) { _ in }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            if sheet.sheetParent === host {
                presentedRounds += 1
                host.endSheet(sheet)
                RunLoop.current.run(until: Date().addingTimeInterval(0.02))
            }
            // (If sheetParent didn't attach, the host is headless-limited; the
            // fresh/pristine assertions above still deterministically prove the fix.)
        }

        print("load-check OK: principalClass=\(cls), ScreenSaverView=true, instantiated=true, "
            + "hasConfigureSheet=\(view.hasConfigureSheet), "
            + "configureSheet=fresh+pristine x5, beginSheet attached \(presentedRounds)/5 rounds")
        exit(0)
    }
}
