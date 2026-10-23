// @chatwing
import UIKit

/// The text size the user has dialed in with ⌘+ and ⌘−, as points added to the
/// system's preferred body size. Kept outside the Mac-only code below because
/// the web app is told its font size in one place for every platform, and that
/// place shouldn't need to know who can change this.
enum TextSizeAdjustment {
    private static let key = "text_size_adjustment"
    private static let range: ClosedRange<Double> = -4...8

    static var points: Double {
        get { UserDefaults.standard.double(forKey: key) }
        set { UserDefaults.standard.set(min(max(newValue, range.lowerBound), range.upperBound), forKey: key) }
    }

    /// What the web app should treat as the preferred body font size.
    static var preferredFontSize: CGFloat {
        UIFont.preferredFont(forTextStyle: .body).pointSize + CGFloat(points)
    }
}

#if targetEnvironment(macCatalyst)

// The Mac app's menu bar, and the keyboard shortcuts that come with it — the
// ones a browser would have given the web app for free.
//
// Most commands are just forwarded to the web app (`menu_onCommand`), which
// knows what "back" or "search" means on the screen it's showing. The ones the
// shell can do by itself work even when the page can't answer: text size is
// ours to set, and reloading is the way out of a page that has stopped
// responding, so it mustn't depend on that page.
//
// The web app tells us its tabs (`setTabs`) so they can be listed by name under
// ⌘1, ⌘2, and so on.
class MenuPlugin: WebAppPlugin {
    private(set) static weak var shared: MenuPlugin?

    private var tabs: [String] = []

    override var name: String {
        return "menu"
    }

    override init(webApp: WebAppViewController) {
        super.init(webApp: webApp)
        MenuPlugin.shared = self
    }

    override var features: [String: Any] {
        return ["available": true]
    }

    override func handleMessage(name: String, body: [String: Any]) -> Bool {
        switch name {
        case "setTabs":
            let titles = body["titles"] as? [String] ?? []
            if titles != tabs {
                tabs = titles
                UIMenuSystem.main.setNeedsRebuild()
            }
            return true
        default:
            return false
        }
    }

    //
    // Building
    //

    /// Call from the app delegate's `buildMenu(with:)`.
    static func buildMenu(with builder: UIMenuBuilder) {
        guard builder.system == .main else { return }

        // Formatting commands mean nothing here, and they sit on ⌘+ and ⌘−.
        builder.remove(menu: .format)
        // UIKit's Find drives a find bar we don't have, and holds ⌘F.
        builder.remove(menu: .find)

        // "Settings…" should open the app's settings, which live in the web
        // app. Whatever was there (the Settings bundle's window, where the
        // development server is chosen) stays reachable with Option held.
        let systemSettings = (builder.menu(for: .preferences)?.children ?? []).compactMap { $0 as? UIKeyCommand }
        builder.replaceChildren(ofMenu: .preferences) { _ in
            var children: [UIMenuElement] = [
                command("Settings…", "settings", input: ",")
            ]
            for item in systemSettings {
                guard let action = item.action else { continue }
                children.append(UIKeyCommand(
                    title: "Developer Settings…",
                    action: action,
                    input: ",",
                    modifierFlags: [.command, .alternate]
                ))
            }
            return children
        }

        builder.insertChild(UIMenu(title: "", options: .displayInline, children: [
            command("Check for New Version", "checkForUpdate", input: "r"),
            command("Reload", "reload", input: "r", modifiers: [.command, .shift]),
        ]), atStartOfMenu: .view)

        builder.insertChild(UIMenu(title: "", options: .displayInline, children: [
            command("Actual Size", "textSizeReset", input: "0"),
            command("Zoom In", "textSizeUp", input: "+"),
            command("Zoom Out", "textSizeDown", input: "-"),
        ]), atStartOfMenu: .view)

        var go: [UIMenuElement] = [
            UIMenu(title: "", options: .displayInline, children: [
                command("Back", "back", input: "["),
                command("Forward", "forward", input: "]"),
            ]),
            UIMenu(title: "", options: .displayInline, children: [
                command("Search", "search", input: "f"),
            ]),
        ]

        let tabs = (shared?.tabs ?? []).prefix(9).enumerated().map { index, title in
            command(title, "tab", input: "\(index + 1)", index: index)
        }
        if !tabs.isEmpty {
            go.append(UIMenu(title: "", options: .displayInline, children: tabs))
        }

        builder.insertSibling(UIMenu(title: "Go", children: go), afterMenu: .view)
    }

    private static func command(
        _ title: String,
        _ name: String,
        input: String,
        modifiers: UIKeyModifierFlags = .command,
        index: Int? = nil
    ) -> UIKeyCommand {
        var properties: [String: Any] = ["name": name]
        if let index = index { properties["index"] = index }

        return UIKeyCommand(
            title: title,
            action: #selector(WebAppViewController.performMenuCommand(_:)),
            input: input,
            modifierFlags: modifiers,
            propertyList: properties
        )
    }

    //
    // Performing
    //

    func perform(_ properties: [String: Any]) {
        guard let name = properties["name"] as? String else { return }

        switch name {
        case "textSizeUp":
            setTextSize(TextSizeAdjustment.points + 1)
        case "textSizeDown":
            setTextSize(TextSizeAdjustment.points - 1)
        case "textSizeReset":
            setTextSize(0)
        case "reload":
            webApp.reload()
        case "checkForUpdate":
            checkForUpdate()
        default:
            sendToPluginListener("onCommand", args: webApp.encodeJSON(properties))
        }
    }

    private func setTextSize(_ points: Double) {
        TextSizeAdjustment.points = points
        // The same message a Dynamic Type change sends.
        webApp.sendToWindowListener("onPreferredFontSizeChange", args: "\(TextSizeAdjustment.preferredFontSize)")
    }

    /// Looks for a newer web bundle right now, and tells the web app how it
    /// goes so it can say so. A new bundle reloads the page when it lands, the
    /// same as one found by the periodic check.
    private func checkForUpdate() {
        guard usingCachedWebBundle, let bundle = (UIApplication.shared.delegate as? AppDelegate)?.webBundle else {
            // Loaded straight from a server, so the newest version is whatever
            // a reload fetches.
            webApp.reload()
            return
        }

        reportUpdateCheck("checking")

        bundle.checkNow { [weak self] result in
            switch result {
            case .upToDate: self?.reportUpdateCheck("upToDate")
            case .downloading: self?.reportUpdateCheck("downloading")
            case .failed: self?.reportUpdateCheck("failed")
            }
        }
    }

    private func reportUpdateCheck(_ state: String) {
        sendToPluginListener("onUpdateCheck", args: webApp.encodeJSON(["state": state]))
    }
}

extension WebAppViewController {
    @objc func performMenuCommand(_ sender: UICommand) {
        guard let properties = sender.propertyList as? [String: Any] else { return }
        MenuPlugin.shared?.perform(properties)
    }
}

#endif
