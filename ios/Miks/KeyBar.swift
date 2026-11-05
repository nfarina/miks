import UIKit

/// The keys a touch screen's keyboard hasn't (Esc, ⌃C, Tab, ⇧Tab for Claude
/// Code's modes, Ctrl, arrows) and symbols it buries, as the keyboard's own
/// accessory bar (`WKWebView.inputAccessory`), which iOS keeps on top of it and
/// moves with it. The page shows it while a terminal has the keyboard (and no
/// hardware one's connected), and says Ctrl's state; each key goes to it by
/// name (`miks_key`, `ui/KeyBar.tsx`). On the iPhone Duo in the laptop pose iOS
/// puts it above the fold, counting the band as the keyboard's: there's no spot
/// for an app's keys on the half on the table (the iPhone keyboard draws no
/// shortcut groups from `inputAssistantItem`; tried).
final class KeyBar: UIInputView, UIScrollViewDelegate {
    private let onKey: (String) -> Void
    private var ctrlButton: UIButton!
    /// Ctrl's own look, which each state starts from.
    private var ctrlConfig: UIButton.Configuration?
    private let scroller = UIScrollView()
    private let scrollerClip = UIView()
    private let fade = CAGradientLayer()
    private var repeatTimer: Timer?

    /// "off", "once" (the next key), or "locked".
    var ctrl = "off" {
        didSet { if ctrl != oldValue { styleCtrl() } }
    }

    init(onKey: @escaping (String) -> Void) {
        self.onKey = onKey
        super.init(frame: CGRect(x: 0, y: 0, width: 320, height: 50), inputViewStyle: .keyboard)
        allowsSelfSizing = true
        translatesAutoresizingMaskIntoConstraints = false

        let keys = UIStackView()
        keys.axis = .horizontal
        keys.spacing = 6
        keys.translatesAutoresizingMaskIntoConstraints = false

        keys.addArrangedSubview(key(title: "esc", "escape"))
        keys.addArrangedSubview(key(title: "⌃C", "interrupt"))
        keys.addArrangedSubview(key(title: "tab", "tab"))
        keys.addArrangedSubview(key(title: "⇧tab", "backtab"))
        ctrlButton = key(title: "ctrl", "ctrl")
        ctrlConfig = ctrlButton.configuration
        keys.addArrangedSubview(ctrlButton)
        for (symbol, name) in [("arrow.left", "left"), ("arrow.up", "up"), ("arrow.down", "down"), ("arrow.right", "right")] {
            keys.addArrangedSubview(key(image: symbol, name, repeats: true))
        }
        for symbol in ["|", "~", "/", "-"] {
            keys.addArrangedSubview(key(title: symbol, symbol))
        }

        // The keys scroll if they don't fit; putting the keyboard away stays
        // at the end, in view (an iPad's keyboard has its own, an iPhone's
        // hasn't). Faded at an edge with more keys past it, from a view around
        // the scroller (a scroller's own mask would scroll with its keys).
        scroller.delegate = self
        scroller.showsHorizontalScrollIndicator = false
        scroller.alwaysBounceHorizontal = false
        scroller.delaysContentTouches = false
        scroller.translatesAutoresizingMaskIntoConstraints = false
        scroller.addSubview(keys)
        scrollerClip.translatesAutoresizingMaskIntoConstraints = false
        scrollerClip.addSubview(scroller)
        fade.startPoint = CGPoint(x: 0, y: 0.5)
        fade.endPoint = CGPoint(x: 1, y: 0.5)
        scrollerClip.layer.mask = fade

        let dismiss = key(image: "keyboard.chevron.compact.down", "dismiss", onRelease: true)
        addSubview(scrollerClip)
        addSubview(dismiss)

        let content = scroller.contentLayoutGuide
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 50),
            scrollerClip.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor),
            scrollerClip.topAnchor.constraint(equalTo: topAnchor),
            scrollerClip.bottomAnchor.constraint(equalTo: bottomAnchor),
            scrollerClip.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -6),
            scroller.leadingAnchor.constraint(equalTo: scrollerClip.leadingAnchor),
            scroller.trailingAnchor.constraint(equalTo: scrollerClip.trailingAnchor),
            scroller.topAnchor.constraint(equalTo: scrollerClip.topAnchor),
            scroller.bottomAnchor.constraint(equalTo: scrollerClip.bottomAnchor),
            dismiss.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -8),
            dismiss.centerYAnchor.constraint(equalTo: centerYAnchor),
            keys.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            keys.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            keys.centerYAnchor.constraint(equalTo: scroller.centerYAnchor),
            content.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
        ])
        styleCtrl()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        updateFade()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        updateFade()
    }

    /// Fades the edges with more keys past them, over 24pt.
    private func updateFade() {
        let bounds = scrollerClip.bounds
        guard bounds.width > 0 else { return }
        let offset = scroller.contentOffset.x
        let left = offset > 1
        let right = offset + bounds.width < scroller.contentSize.width - 1
        let edge = min(0.5, 24 / bounds.width)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fade.frame = bounds
        fade.colors = [left ? UIColor.clear : .black, UIColor.black, .black, right ? UIColor.clear : .black].map(\.cgColor)
        fade.locations = [0, NSNumber(value: edge), NSNumber(value: 1 - edge), 1]
        CATransaction.commit()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// A key, pressed as the finger lands (as the web bar's were); with
    /// `repeats`, again and again while it's held, as a keyboard's do; with
    /// `onRelease`, as it lifts, inside.
    private func key(title: String? = nil, image: String? = nil, _ name: String, repeats: Bool = false, onRelease: Bool = false) -> UIButton {
        var config = UIButton.Configuration.gray()
        config.cornerStyle = .medium
        config.baseForegroundColor = .label
        config.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 10)
        if let title {
            config.attributedTitle = AttributedString(title, attributes: AttributeContainer([.font: UIFont.systemFont(ofSize: 16)]))
        }
        if let image {
            config.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
        }
        let button = UIButton(configuration: config)
        button.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            button.heightAnchor.constraint(equalToConstant: 38),
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 44),
        ])

        if onRelease {
            button.addAction(UIAction { [weak self] _ in self?.onKey(name) }, for: .touchUpInside)
            return button
        }
        button.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.onKey(name)
            guard repeats else { return }
            self.repeatTimer?.invalidate()
            self.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
                self?.repeatTimer = Timer.scheduledTimer(withTimeInterval: 0.06, repeats: true) { [weak self] _ in
                    self?.onKey(name)
                }
            }
        }, for: .touchDown)
        if repeats {
            button.addAction(UIAction { [weak self] _ in
                self?.repeatTimer?.invalidate()
                self?.repeatTimer = nil
            }, for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        }
        return button
    }

    /// Off, as the other keys; once, inverted; locked, Miks's purple, as the
    /// web bar had. Each from Ctrl's own look: clearing a gray button's
    /// background falls back to the tint, which is blue.
    private func styleCtrl() {
        guard let button = ctrlButton, var config = ctrlConfig else { return }
        switch ctrl {
        case "once":
            config.baseForegroundColor = .systemBackground
            config.background.backgroundColor = .label
        case "locked":
            config.baseForegroundColor = .white
            config.background.backgroundColor = UIColor(red: 0x5b / 255, green: 0x4f / 255, blue: 0xd1 / 255, alpha: 1)
        default:
            break
        }
        button.configuration = config
    }
}
