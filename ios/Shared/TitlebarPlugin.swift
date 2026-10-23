// @chatwing
import UIKit

#if targetEnvironment(macCatalyst)
import ObjectiveC

// Shares the Mac window's title bar with the web, which decides what a press
// up there does.
//
// The web's header shares a row with the traffic lights (see SceneDelegate),
// but the top ~33pt of the window belongs to AppKit's title bar, and there's
// no public way to share it. Two things stand in the way, both verified with
// synthetic clicks:
//
// - The window server drags the window itself for clicks in the title bar's
//   drag region, so they never reach the app at all. That region comes from
//   the title bar views' mouseDownCanMoveWindow, which we turn off.
// - Clicks that do reach the app go straight to NSTitlebarView's mouseDown:,
//   with no hit-testing along the way. So that's where we step in: every
//   press, along with its drag and release, is handed to UIKit's input view,
//   which is how the rest of the window's clicks reach the web view anyway.
//
// So the web gets presses in the title bar like any others, and knows what's
// under them: a button takes its click, and for empty header (anywhere in it,
// title bar or not) the web asks us to drag the window (`startDrag`, NSWindow's
// public performWindowDrag). A double click does nothing more: zooming the
// window from one fought with the drags. The traffic lights are separate views
// and never involved.
//
// That leaves a window nobody can move while the web isn't there to ask: still
// loading, or crashed. So until a page says it's listening (`setReady`), the
// title bar drags the window itself.
//
// These override methods on AppKit classes Apple doesn't document
// (NSTitlebarView, NSTitlebarContainerView) and lean on UIKit's
// UINSInputView. If a future macOS renames or restructures them, the overrides
// just don't install, and the title bar goes back to dragging the window
// rather than clicking.
class TitlebarPlugin: WebAppPlugin {
    override var name: String {
        return "titlebar"
    }

    override init(webApp: WebAppViewController) {
        super.init(webApp: webApp)
        // Before the window is shown, so its drag region is computed without
        // the title bar views.
        TitlebarPassthrough.install()
    }

    override var features: [String: Any] {
        // Only a page that's just loaded asks, and it isn't listening yet.
        TitlebarPassthrough.webReady = false

        // `forwards` tells the web that every press comes to it. Shells before
        // that had it report where its buttons were instead.
        return ["available": TitlebarPassthrough.installed, "forwards": TitlebarPassthrough.installed]
    }

    override func webContentProcessDidTerminate() {
        TitlebarPassthrough.webReady = false
    }

    override func handleMessage(name: String, body: [String: Any]) -> Bool {
        switch name {
        case "setReady":
            TitlebarPassthrough.webReady = (body["ready"] as? Bool) ?? false
            return true
        case "setClickableRects":
            // From a web bundle older than `forwards`. It never says it's
            // ready, so its buttons wait for the next bundle.
            return true
        case "startDrag":
            TitlebarPassthrough.startDrag()
            return true
        default:
            return false
        }
    }
}

private enum TitlebarPassthrough {
    /// Whether the page is listening for presses, and will ask us to drag.
    static var webReady = false
    private(set) static var installed = false

    /// The view we're handing the current click to, from mouseDown: until the
    /// matching mouseUp:.
    private static var forwardingTo: NSObject?

    /// The latest press anywhere in the window.
    private static var lastMouseDown: NSObject?

    /// NSEvent.EventType's raw values.
    private static let leftMouseDown = 1
    private static let leftMouseDragged = 6

    private typealias MouseEvent = @convention(c) (AnyObject, Selector, AnyObject) -> Void

    static func install() {
        guard
            !installed,
            let titlebarView = NSClassFromString("NSTitlebarView"),
            let containerView = NSClassFromString("NSTitlebarContainerView")
        else { return }

        // Keep the window server from dragging the window on its own.
        let cantMoveWindow: @convention(block) (AnyObject) -> Bool = { _ in false }
        for viewClass in [titlebarView, containerView] {
            override(viewClass, "mouseDownCanMoveWindow", with: imp_implementationWithBlock(cantMoveWindow))
        }

        // Hand presses to UIKit instead of the title bar, for the web to
        // decide on. While it isn't listening, drag the window ourselves.
        overrideMouse(titlebarView, "mouseDown:") { view, event in
            if webReady, let target = inputView(in: view) {
                forwardingTo = target
                send("mouseDown:", event, to: target)
                return true
            }
            forwardingTo = nil

            guard let window = view.value(forKey: "window") as? NSObject else { return false }
            send("performWindowDragWithEvent:", event, to: window)
            return true
        }
        overrideMouse(titlebarView, "mouseDragged:") { _, event in
            guard let target = forwardingTo else { return false }
            send("mouseDragged:", event, to: target)
            return true
        }
        overrideMouse(titlebarView, "mouseUp:") { _, event in
            guard let target = forwardingTo else { return false }
            forwardingTo = nil
            send("mouseUp:", event, to: target)
            return true
        }

        // Remember each press, for dragging the window from the web's side.
        if let window = NSClassFromString("UINSWindow") {
            overrideMouse(window, "sendEvent:") { _, event in
                if (event.value(forKey: "type") as? NSNumber)?.intValue == leftMouseDown {
                    lastMouseDown = event
                }
                return false
            }
        }

        installed = true
    }

    /// Drags the window for a press the web got on its header. That takes the
    /// press itself, which we kept as it came through the window: by the time
    /// the web's message arrives, the app's current event is often something
    /// else (the first press after the pointer moves onto the header never
    /// was it).
    static func startDrag() {
        guard let event = pressInProgress(), let window = event.value(forKey: "window") as? NSObject else { return }
        send("performWindowDragWithEvent:", event, to: window)
    }

    /// The press the mouse button is still down from, if any.
    private static func pressInProgress() -> NSObject? {
        let buttons = (NSClassFromString("NSEvent") as AnyObject?)?.value(forKey: "pressedMouseButtons") as? NSNumber
        guard let buttons, buttons.intValue & 1 == 1 else { return nil }
        if let lastMouseDown { return lastMouseDown }

        // No window class to watch presses on, so go by the current event.
        guard
            let application = (NSClassFromString("NSApplication") as AnyObject?)?
                .value(forKey: "sharedApplication") as? NSObject,
            let event = application.value(forKey: "currentEvent") as? NSObject,
            let type = (event.value(forKey: "type") as? NSNumber)?.intValue,
            type == leftMouseDown || type == leftMouseDragged
        else { return nil }
        return event
    }

    /// Adds `implementation` to `viewClass` alone (rather than replacing an
    /// inherited NSView method for every view in the app), or replaces its own.
    private static func override(_ viewClass: AnyClass, _ selectorName: String, with implementation: IMP) {
        let selector = NSSelectorFromString(selectorName)
        guard let method = class_getInstanceMethod(viewClass, selector) else { return }
        if !class_addMethod(viewClass, selector, implementation, method_getTypeEncoding(method)) {
            method_setImplementation(method, implementation)
        }
    }

    /// Overrides a mouse event method; `handle` returns true to take the
    /// event, or false to let the original have it.
    private static func overrideMouse(
        _ viewClass: AnyClass,
        _ selectorName: String,
        handle: @escaping (NSObject, NSObject) -> Bool
    ) {
        let selector = NSSelectorFromString(selectorName)
        guard let method = class_getInstanceMethod(viewClass, selector) else { return }
        let original = unsafeBitCast(method_getImplementation(method), to: MouseEvent.self)

        let block: @convention(block) (NSObject, NSObject) -> Void = { view, event in
            if !handle(view, event) {
                original(view, selector, event)
            }
        }
        override(viewClass, selectorName, with: imp_implementationWithBlock(block))
    }

    private static func send(_ selectorName: String, _ event: NSObject, to target: NSObject) {
        let selector = NSSelectorFromString(selectorName)
        let implementation = unsafeBitCast(target.method(for: selector), to: MouseEvent.self)
        implementation(target, selector, event)
    }

    /// UIKit's view for the window's mouse input, found under the window's
    /// content view.
    private static func inputView(in view: NSObject) -> NSObject? {
        guard
            let window = view.value(forKey: "window") as? NSObject,
            let contentView = window.value(forKey: "contentView") as? NSObject
        else { return nil }
        return find("UINSInputView", in: contentView)
    }

    private static func find(_ className: String, in view: NSObject) -> NSObject? {
        if String(describing: type(of: view)) == className { return view }
        for subview in (view.value(forKey: "subviews") as? [NSObject]) ?? [] {
            if let found = find(className, in: subview) { return found }
        }
        return nil
    }
}
#endif
