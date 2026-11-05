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
final class KeyBar: UIInputView {
    private let onKey: (String) -> Void
    private var ctrlButton: UIButton!
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
        keys.addArrangedSubview(ctrlButton)
        for (symbol, name) in [("arrow.left", "left"), ("arrow.up", "up"), ("arrow.down", "down"), ("arrow.right", "right")] {
            keys.addArrangedSubview(key(image: symbol, name, repeats: true))
        }
        for symbol in ["|", "~", "/", "-"] {
            keys.addArrangedSubview(key(title: symbol, symbol))
        }

        // The keys scroll if they don't fit; putting the keyboard away stays
        // at the end, in view (an iPad's keyboard has its own, an iPhone's
        // hasn't).
        let scroller = UIScrollView()
        scroller.showsHorizontalScrollIndicator = false
        scroller.alwaysBounceHorizontal = false
        scroller.delaysContentTouches = false
        scroller.translatesAutoresizingMaskIntoConstraints = false
        scroller.addSubview(keys)

        let dismiss = key(image: "keyboard.chevron.compact.down", "dismiss", onRelease: true)
        addSubview(scroller)
        addSubview(dismiss)

        let content = scroller.contentLayoutGuide
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 50),
            scroller.leadingAnchor.constraint(equalTo: safeAreaLayoutGuide.leadingAnchor),
            scroller.topAnchor.constraint(equalTo: topAnchor),
            scroller.bottomAnchor.constraint(equalTo: bottomAnchor),
            scroller.trailingAnchor.constraint(equalTo: dismiss.leadingAnchor, constant: -6),
            dismiss.trailingAnchor.constraint(equalTo: safeAreaLayoutGuide.trailingAnchor, constant: -8),
            dismiss.centerYAnchor.constraint(equalTo: centerYAnchor),
            keys.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 8),
            keys.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            keys.centerYAnchor.constraint(equalTo: scroller.centerYAnchor),
            content.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
        ])
        styleCtrl()
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

    /// Off, plain; once, inverted; locked, Miks's purple, as the web bar had.
    private func styleCtrl() {
        guard let button = ctrlButton, var config = button.configuration else { return }
        switch ctrl {
        case "once":
            config.baseBackgroundColor = .label
            config.baseForegroundColor = .systemBackground
            config.background.backgroundColor = .label
        case "locked":
            let purple = UIColor(red: 0x5b / 255, green: 0x4f / 255, blue: 0xd1 / 255, alpha: 1)
            config.baseForegroundColor = .white
            config.background.backgroundColor = purple
        default:
            config.baseForegroundColor = .label
            config.background.backgroundColor = nil
        }
        button.configuration = config
    }
}
