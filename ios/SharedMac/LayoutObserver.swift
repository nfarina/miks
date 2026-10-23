// @chatwing
import AppKit

/// Reports the web view's layout to the web app, in the same shape as the iOS
/// shell's LayoutObserver (ios/Shared), so the web lays out from one set of
/// signals everywhere.
///
/// A Mac window has far fewer of them: no safe area, fold or bar edge. What it
/// does have is the traffic lights, which sit over our content in the top-left
/// corner (see WebAppWindow), so a bar running along the top, like the web's
/// header, has to start past them. They're reported the way iOS reports a
/// rounded screen corner, as a horizontal `safeAreaCorners` inset.
class LayoutObserver {

    private let log = Logger(prefix: "layout")

    /// The latest layout, or nil before the web view is in a window.
    private(set) var layout: [String: Any]?

    /// Called whenever the layout changes.
    var onChange: (([String: Any]) -> Void)?

    /// Points per CSS pixel, i.e. the web view's pageZoom. Lengths are reported
    /// in CSS pixels, so they only match our points at 1.
    var pointsPerCSSPixel: CGFloat = 1 {
        didSet { if pointsPerCSSPixel != oldValue { update() } }
    }

    private weak var view: NSView?
    private weak var window: NSWindow?
    private var lastJSON = ""

    func observe(_ view: NSView) {
        self.view = view
        view.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(update), name: NSView.frameDidChangeNotification, object: view)
    }

    func attach(to window: NSWindow) {
        guard self.window !== window else { return }
        self.window = window

        // Full screen hides the traffic lights, and moving to another screen
        // changes the screen we report.
        for name in [
            NSWindow.didEnterFullScreenNotification,
            NSWindow.didExitFullScreenNotification,
            NSWindow.didChangeScreenNotification,
            NSWindow.didMoveNotification,
        ] {
            NotificationCenter.default.addObserver(self, selector: #selector(update), name: name, object: window)
        }
        update()
    }

    @objc private func update() {
        guard let view, let window = view.window else { return }
        let layout = describe(view: view, window: window)

        guard
            let data = try? JSONSerialization.data(withJSONObject: layout, options: [.sortedKeys]),
            let json = String(data: data, encoding: .utf8),
            json != lastJSON
        else { return }

        lastJSON = json
        self.layout = layout
        log.debug(json)
        onChange?(layout)
    }

    private func describe(view: NSView, window: NSWindow) -> [String: Any] {
        let width = n(view.bounds.width)
        let height = n(view.bounds.height)

        var layout: [String: Any] = [
            "width": width,
            "height": height,
            // A Mac has no size classes of its own. These are the thresholds
            // crosswing guesses with in a browser (sizeClassesForSize), so a
            // narrow window lays out like it would in Safari.
            "sizeClass": [
                "horizontal": width >= 700 ? "regular" : "compact",
                "vertical": height >= 500 ? "regular" : "compact",
            ],
            "safeArea": insets(left: 0),
            "safeAreaCorners": ["horizontal": insets(left: trafficLightsInset(window)), "vertical": insets(left: 0)],
        ]

        if let screen = window.screen {
            // Flipped to the top-left origin the web (and iOS) measure from.
            let frame = window.frame
            layout["window"] = [
                "x": n(frame.minX - screen.frame.minX),
                "y": n(screen.frame.maxY - frame.maxY),
                "width": n(frame.width),
                "height": n(frame.height),
            ]
            layout["screen"] = ["width": n(screen.frame.width), "height": n(screen.frame.height)]
        }

        return layout
    }

    /// Where the traffic lights end: the zoom button's far edge. The web keeps
    /// its own gap from there. Nothing to clear in full screen, where they're
    /// hidden.
    private func trafficLightsInset(_ window: NSWindow) -> CGFloat {
        guard
            !window.styleMask.contains(.fullScreen),
            let zoom = window.standardWindowButton(.zoomButton),
            let zoomFrame = zoom.superview?.convert(zoom.frame, to: nil)
        else { return 0 }
        return zoomFrame.maxX
    }

    // Formatting.

    private func n(_ value: CGFloat) -> Double {
        (Double(value / pointsPerCSSPixel) * 10).rounded() / 10
    }

    private func insets(left: CGFloat) -> [String: Any] {
        ["top": 0, "right": 0, "bottom": 0, "left": n(left)]
    }
}
