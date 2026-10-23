// @chatwing
import UIKit

/// Watches the layout signals iOS gives us to adapt to device poses (iPhone
/// Duo folded/open/closed, Split View, rotation, etc) and reports them as a
/// JSON-friendly dictionary for the web app.
///
/// Sticks to the signals Apple sanctions for layout: scene bounds, size
/// classes, safe areas, reserved regions (fold + cameras), and the vertical
/// bar edge. Deliberately doesn't report device model or idiom, since Apple
/// says not to make layout decisions from those. Hinge state is included as
/// context only; reserved regions are what layout should key off.
///
/// It's a hidden, full-size, non-interactive view added alongside the web
/// view, so its coordinate space is the web view's (in points; see
/// pointsPerCSSPixel for page zoom) and it gets layout, safe area, and trait
/// callbacks without the host controller overriding anything.
///
/// The iOS 27.1 APIs are fenced with `SDK_BEFORE_27_1`, which the project sets
/// for the 27.0 SDKs, so the app still builds on release Xcode (and Xcode
/// Cloud) until 27.1 ships. Built that way, the app reports no bar edge, bars,
/// reserved regions, or hinge.
class LayoutObserver: UIView {

    private let log = Logger(prefix: "layout")

    /// The latest layout, or nil before the view is in a window.
    private(set) var layout: [String: Any]?

    /// Called whenever the layout changes.
    var onChange: (([String: Any]) -> Void)?

    /// Points per CSS pixel, i.e. the web view's pageZoom. Lengths are reported
    /// in CSS pixels, so they only match our points at 1.
    var pointsPerCSSPixel: CGFloat = 1 {
        didSet { if pointsPerCSSPixel != oldValue { update() } }
    }

    private var lastJSON = ""
    private var hinge: [String: Any]?
    private var settleTimer: Timer?
    private var lastSize = CGSize.zero

    /// The bar thickness we ask the system to place, to learn where it would
    /// route a bar around the cameras and status bar on each edge.
    private let barExtent: CGFloat = 44

    override init(frame: CGRect) {
        super.init(frame: frame)
        autoresizingMask = [.flexibleWidth, .flexibleHeight]
        isUserInteractionEnabled = false
        isHidden = true

        if #available(iOS 17.0, *) {
            var traits: [UITrait] = [
                UITraitHorizontalSizeClass.self,
                UITraitVerticalSizeClass.self,
                UITraitLayoutDirection.self,
            ]
            #if !SDK_BEFORE_27_1 && !targetEnvironment(macCatalyst)
            if #available(iOS 27.1, *) {
                traits += UITraitCollection.systemTraitsAffectingVerticalBarEdge
            }
            #endif
            registerForTraitChanges(traits) { (self: Self, _: UITraitCollection) in
                self.update()
            }
        }

        #if !SDK_BEFORE_27_1 && !targetEnvironment(macCatalyst)
        if #available(iOS 27.1, *) {
            addInteraction(UIHingeInteraction { [weak self] _, update in
                guard let self else { return }
                if let hinge = update.hinge {
                    // Round the angle so continuous drags don't flood the bridge.
                    let degrees = (hinge.angle * 180 / .pi / 5).rounded() * 5
                    self.hinge = ["status": name(hinge.status), "angle": degrees]
                } else {
                    self.hinge = nil
                }
                self.update()
                self.settle()
            })
        }
        #endif
    }

    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        update()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        update()
        if bounds.size != lastSize {
            lastSize = bounds.size
            settle()
        }
    }

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
        update()
    }

    // Reserved regions have no change callback, and they lag the events we
    // do get: on iPhone Duo the fold stays active for a moment after the hinge
    // reports fully open, and the first read after opening still has the outer
    // display's cameras. So after a hinge or size change, keep re-reading for a
    // second until things settle. Unchanged reads are dropped by update().
    private func settle() {
        settleTimer?.invalidate()
        var remaining = 10
        settleTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] timer in
            remaining -= 1
            if remaining <= 0 { timer.invalidate() }
            self?.update()
        }
    }

    private func update() {
        guard let window else { return }
        let layout = describe(window: window)

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

    private func describe(window: UIWindow) -> [String: Any] {
        var layout: [String: Any] = [
            "width": n(bounds.width),
            "height": n(bounds.height),
            "sizeClass": [
                "horizontal": name(traitCollection.horizontalSizeClass),
                "vertical": name(traitCollection.verticalSizeClass),
            ],
            "safeArea": insets(safeAreaInsets),
        ]

        if #available(iOS 26.0, *) {
            // The plain safe area ignores rounded screen corners. These also
            // clear the corners, along one axis: "horizontal" pushes the left
            // and right insets in (for content running along the top or
            // bottom edge), "vertical" pushes the top and bottom in.
            layout["safeAreaCorners"] = [
                "horizontal": insets(edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))),
                "vertical": insets(edgeInsets(for: .safeArea(cornerAdaptation: .vertical))),
            ]
        }

        // Where our window sits on its screen. A window narrower than its
        // screen, or offset from its origin, means Split View or a resized
        // scene, and the offset says which side we're on.
        if let scene = window.windowScene {
            let screen = scene.screen
            let frame = window.convert(window.bounds, to: screen.coordinateSpace)
            layout["window"] = rect(frame)
            layout["screen"] = ["width": n(screen.bounds.width), "height": n(screen.bounds.height)]
            layout["orientation"] = name(scene.effectiveGeometry.interfaceOrientation)
        }

        #if !SDK_BEFORE_27_1 && !targetEnvironment(macCatalyst)
        if #available(iOS 27.1, *) {
            // Resolved to a physical edge, which is what CSS positions by.
            let rtl = traitCollection.layoutDirection == .rightToLeft
            switch traitCollection.verticalBarEdge {
            case .leading: layout["barEdge"] = rtl ? "right" : "left"
            case .trailing: layout["barEdge"] = rtl ? "left" : "right"
            default: break
            }

            var bars: [String: Any] = [:]
            for (label, edge) in [("top", UIRectEdge.top), ("left", .left), ("bottom", .bottom), ("right", .right)] {
                let barInsets = edgeInsets(for: .bar(onEdge: edge, extent: barExtent))
                bars[label] = rect(bounds.inset(by: barInsets))
            }
            layout["bars"] = bars

            // Include inactive regions so the fold shows up (inactive) when
            // fully open, not just when partially folded.
            layout["occlusions"] = reservedRegions(kind: .occlusion, options: .includeInactive).map(region)
            layout["divisions"] = reservedRegions(kind: .division, options: .includeInactive).map(region)
        }
        #endif

        #if targetEnvironment(macCatalyst)
        // The traffic lights sit in our top-left corner (the title bar's safe
        // area is cancelled; see WebAppViewController), so a bar running
        // along the top, like the web's header, has to start past them. AppKit
        // won't say where they are; measured with the unified toolbar
        // SceneDelegate sets, they end 79pt in.
        let trafficLights = UIEdgeInsets(top: 0, left: 79, bottom: 0, right: 0)
        layout["safeAreaCorners"] = ["horizontal": insets(trafficLights), "vertical": insets(.zero)]
        #endif

        if let hinge {
            layout["hinge"] = hinge
        }

        return layout
    }

    // Formatting.

    private func n(_ value: CGFloat) -> Double {
        (Double(value / pointsPerCSSPixel) * 10).rounded() / 10
    }

    private func rect(_ rect: CGRect) -> [String: Any] {
        ["x": n(rect.minX), "y": n(rect.minY), "width": n(rect.width), "height": n(rect.height)]
    }

    private func insets(_ insets: UIEdgeInsets) -> [String: Any] {
        ["top": n(insets.top), "right": n(insets.right), "bottom": n(insets.bottom), "left": n(insets.left)]
    }

    #if !SDK_BEFORE_27_1 && !targetEnvironment(macCatalyst)
    @available(iOS 27.1, *)
    private func region(_ region: UIView.ReservedRegion) -> [String: Any] {
        ["active": region.isActive, "margins": insets(region.margins)].merging(rect(region.frame)) { a, _ in a }
    }
    #endif

    private func name(_ sizeClass: UIUserInterfaceSizeClass) -> String {
        switch sizeClass {
        case .compact: "compact"
        case .regular: "regular"
        default: "unspecified"
        }
    }

    private func name(_ orientation: UIInterfaceOrientation) -> String {
        switch orientation {
        case .portrait: "portrait"
        case .portraitUpsideDown: "portraitUpsideDown"
        case .landscapeLeft: "landscapeLeft"
        case .landscapeRight: "landscapeRight"
        default: "unknown"
        }
    }

    #if !SDK_BEFORE_27_1 && !targetEnvironment(macCatalyst)
    @available(iOS 27.1, *)
    private func name(_ status: UIHinge.Status) -> String {
        switch status {
        case .closed: "closed"
        case .partiallyOpen: "partiallyOpen"
        case .fullyOpen: "fullyOpen"
        default: "unknown"
        }
    }
    #endif
}
