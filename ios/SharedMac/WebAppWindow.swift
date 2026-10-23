// @chatwing
import AppKit

/// The app's one window, with just the traffic lights over the web app, like
/// Music or Safari: the web's header shares their row. The toolbar is empty;
/// its unified style is only there to make the title bar as tall as our
/// header, which centers the traffic lights on it.
///
/// Closing the window hides it rather than tearing down the web app, so the
/// chat stays connected and comes back as it was from the Dock.
class WebAppWindow: NSWindow, NSWindowDelegate {

    init(contentViewController: NSViewController) {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        self.contentViewController = contentViewController
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        toolbar = NSToolbar(identifier: "main")
        toolbarStyle = .unified
        titlebarSeparatorStyle = .none
        minSize = NSSize(width: 360, height: 400)
        tabbingMode = .disallowed
        delegate = self

        setContentSize(NSSize(width: 1100, height: 760))
        center()
        setFrameAutosaveName("Main")
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        orderOut(nil)
        return false
    }
}
