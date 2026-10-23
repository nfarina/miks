// @chatwing
import AppKit

// Shares the window's title bar with the web, which decides what a press up
// there does.
//
// The web's header shares a row with the traffic lights (see WebAppWindow), so
// a press in that row might be on one of its buttons, or on empty header,
// which should drag the window like any title bar. Only the web knows which.
// So the web view gets every press, and for empty header the web asks us to
// drag the window (`startDrag`). The traffic lights are separate views and
// never involved.
//
// That leaves a window nobody can move while the web isn't there to ask: still
// loading, or crashed. So until a page says it's listening (`setReady`), a
// strip over the title bar drags the window itself.
class TitlebarPlugin: WebAppPlugin, WindowAttachingPlugin {
    override var name: String {
        return "titlebar"
    }

    /// Whether the page is listening for presses, and will ask us to drag.
    private var webReady = false {
        didSet { dragStrip.isHidden = webReady }
    }

    private let dragStrip = DragStrip()

    /// The latest press anywhere in the window. By the time the web's
    /// `startDrag` arrives, the app's current event is often something else.
    private var lastMouseDown: NSEvent?
    private var monitor: Any?

    override var features: [String: Any] {
        // Only a page that's just loaded asks, and it isn't listening yet.
        webReady = false

        // `forwards` tells the web that every press comes to it. Shells before
        // that had it report where its buttons were instead.
        return ["available": true, "forwards": true]
    }

    func attach(to window: NSWindow) {
        guard monitor == nil, let contentView = window.contentView else { return }

        monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.lastMouseDown = event
            return event
        }

        // As tall as the title bar, which the empty toolbar makes as tall as
        // the web's header.
        let height = window.frame.height - window.contentLayoutRect.height
        dragStrip.frame = NSRect(x: 0, y: contentView.bounds.height - height, width: contentView.bounds.width, height: height)
        dragStrip.autoresizingMask = [.width, .minYMargin]
        dragStrip.isHidden = webReady
        contentView.addSubview(dragStrip)
    }

    override func webContentProcessDidTerminate() {
        webReady = false
    }

    override func handleMessage(name: String, body: [String: Any]) -> Bool {
        switch name {
        case "setReady":
            webReady = (body["ready"] as? Bool) ?? false
            return true
        case "setClickableRects":
            // From a web bundle older than `forwards`. It never says it's
            // ready, so its buttons wait for the next bundle.
            return true
        case "startDrag":
            startDrag()
            return true
        default:
            return false
        }
    }

    /// Drags the window for the press the web got on its header, if the
    /// button is still down from it.
    private func startDrag() {
        guard
            NSEvent.pressedMouseButtons & 1 == 1,
            let event = lastMouseDown,
            let window = event.window
        else { return }
        window.performDrag(with: event)
    }
}

/// Drags the window from anywhere on it, and double-clicks the way the user
/// has chosen for title bars (zoom, minimize, or nothing).
private class DragStrip: NSView {
    override func mouseDown(with event: NSEvent) {
        guard let window else { return }

        if event.clickCount == 2 {
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
            return
        }

        window.performDrag(with: event)
    }
}
