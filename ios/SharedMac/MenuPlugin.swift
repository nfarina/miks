// @chatwing
import AppKit

/// The text size the user has dialed in with ⌘+ and ⌘−, as points added to the
/// Mac's 13pt body size.
enum TextSizeAdjustment {
    private static let key = "text_size_adjustment"
    private static let range: ClosedRange<Double> = -4...8

    static var points: Double {
        get { UserDefaults.standard.double(forKey: key) }
        set { UserDefaults.standard.set(min(max(newValue, range.lowerBound), range.upperBound), forKey: key) }
    }

    /// What the web app should treat as the preferred body font size.
    static var preferredFontSize: CGFloat {
        NSFont.systemFontSize + CGFloat(points)
    }
}

// The menu bar, and the keyboard shortcuts that come with it — the ones a
// browser would have given the web app for free.
//
// Most commands are just forwarded to the web app (`menu_onCommand`), which
// knows what "back" or "search" means on the screen it's showing. The ones the
// shell can do by itself work even when the page can't answer: text size is
// ours to set, and reloading is the way out of a page that has stopped
// responding, so it mustn't depend on that page.
//
// The web app tells us its tabs (`setTabs`) so they can be listed by name under
// ⌘1, ⌘2, and so on.
//
// The Edit menu's commands have no target, so they travel the responder chain
// to the web view, which is what makes copy, paste, undo, spelling and the
// rest work in its text fields.
class MenuPlugin: WebAppPlugin {
    private var tabs: [String] = []
    private let goMenu = NSMenu(title: "Go")

    override var name: String {
        return "menu"
    }

    override init(webApp: WebAppViewController) {
        super.init(webApp: webApp)
        NSApp.mainMenu = buildMainMenu()
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
                rebuildGoMenu()
            }
            return true
        default:
            return false
        }
    }

    //
    // Building
    //

    private func buildMainMenu() -> NSMenu {
        let appName = ProcessInfo.processInfo.processName
        let main = NSMenu()

        let app = NSMenu(title: appName)
        app.addItem(withTitle: "About \(appName)", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        // "Settings…" opens the app's settings, which live in the web app.
        // Choosing the development server is with Option held.
        app.addItem(command("Settings…", "settings", key: ","))
        let developer = NSMenuItem(title: "Developer Settings…", action: #selector(showDeveloperSettings), keyEquivalent: ",")
        developer.keyEquivalentModifierMask = [.command, .option]
        developer.target = self
        developer.isAlternate = true
        app.addItem(developer)
        app.addItem(.separator())
        let services = NSMenu(title: "Services")
        app.addItem(submenu(services))
        NSApp.servicesMenu = services
        app.addItem(.separator())
        app.addItem(withTitle: "Hide \(appName)", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
            .keyEquivalentModifierMask = [.command, .option]
        app.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Quit \(appName)", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        main.addItem(submenu(app))

        let file = NSMenu(title: "File")
        file.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        main.addItem(submenu(file))

        main.addItem(submenu(editMenu()))

        let view = NSMenu(title: "View")
        view.addItem(command("Check for New Version", "checkForUpdate", key: "r"))
        view.addItem(command("Reload", "reload", key: "r", modifiers: [.command, .shift]))
        view.addItem(.separator())
        view.addItem(command("Actual Size", "textSizeReset", key: "0"))
        view.addItem(command("Zoom In", "textSizeUp", key: "+"))
        // ⌘+ is ⇧⌘= on most keyboards, and people press ⌘= expecting it.
        let zoomIn = command("Zoom In", "textSizeUp", key: "=")
        zoomIn.isHidden = true
        zoomIn.allowsKeyEquivalentWhenHidden = true
        view.addItem(zoomIn)
        view.addItem(command("Zoom Out", "textSizeDown", key: "-"))
        view.addItem(.separator())
        // AppKit adds Enter Full Screen below.
        main.addItem(submenu(view))

        rebuildGoMenu()
        main.addItem(submenu(goMenu))

        let window = NSMenu(title: "Window")
        window.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        window.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        window.addItem(.separator())
        window.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        main.addItem(submenu(window))
        NSApp.windowsMenu = window

        return main
    }

    /// The standard Edit menu, as Xcode's app template builds it. AppKit adds
    /// AutoFill, Dictation, and Emoji & Symbols to the end.
    private func editMenu() -> NSMenu {
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Paste and Match Style", action: #selector(NSTextView.pasteAsPlainText(_:)), keyEquivalent: "V")
            .keyEquivalentModifierMask = [.command, .option, .shift]
        edit.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        edit.addItem(.separator())

        let spelling = NSMenu(title: "Spelling and Grammar")
        spelling.addItem(withTitle: "Show Spelling and Grammar", action: #selector(NSText.showGuessPanel(_:)), keyEquivalent: ":")
        spelling.addItem(withTitle: "Check Document Now", action: #selector(NSText.checkSpelling(_:)), keyEquivalent: ";")
        spelling.addItem(.separator())
        spelling.addItem(withTitle: "Check Spelling While Typing", action: #selector(NSTextView.toggleContinuousSpellChecking(_:)), keyEquivalent: "")
        spelling.addItem(withTitle: "Check Grammar With Spelling", action: #selector(NSTextView.toggleGrammarChecking(_:)), keyEquivalent: "")
        spelling.addItem(withTitle: "Correct Spelling Automatically", action: #selector(NSTextView.toggleAutomaticSpellingCorrection(_:)), keyEquivalent: "")
        edit.addItem(submenu(spelling))

        let substitutions = NSMenu(title: "Substitutions")
        substitutions.addItem(withTitle: "Show Substitutions", action: #selector(NSTextView.orderFrontSubstitutionsPanel(_:)), keyEquivalent: "")
        substitutions.addItem(.separator())
        substitutions.addItem(withTitle: "Smart Copy/Paste", action: #selector(NSTextView.toggleSmartInsertDelete(_:)), keyEquivalent: "")
        substitutions.addItem(withTitle: "Smart Quotes", action: #selector(NSTextView.toggleAutomaticQuoteSubstitution(_:)), keyEquivalent: "")
        substitutions.addItem(withTitle: "Smart Dashes", action: #selector(NSTextView.toggleAutomaticDashSubstitution(_:)), keyEquivalent: "")
        substitutions.addItem(withTitle: "Smart Links", action: #selector(NSTextView.toggleAutomaticLinkDetection(_:)), keyEquivalent: "")
        substitutions.addItem(withTitle: "Text Replacement", action: #selector(NSTextView.toggleAutomaticTextReplacement(_:)), keyEquivalent: "")
        edit.addItem(submenu(substitutions))

        let transformations = NSMenu(title: "Transformations")
        transformations.addItem(withTitle: "Make Upper Case", action: #selector(NSResponder.uppercaseWord(_:)), keyEquivalent: "")
        transformations.addItem(withTitle: "Make Lower Case", action: #selector(NSResponder.lowercaseWord(_:)), keyEquivalent: "")
        transformations.addItem(withTitle: "Capitalize", action: #selector(NSResponder.capitalizeWord(_:)), keyEquivalent: "")
        edit.addItem(submenu(transformations))

        let speech = NSMenu(title: "Speech")
        speech.addItem(withTitle: "Start Speaking", action: #selector(NSTextView.startSpeaking(_:)), keyEquivalent: "")
        speech.addItem(withTitle: "Stop Speaking", action: #selector(NSTextView.stopSpeaking(_:)), keyEquivalent: "")
        edit.addItem(submenu(speech))

        return edit
    }

    private func rebuildGoMenu() {
        goMenu.removeAllItems()
        goMenu.addItem(command("Back", "back", key: "["))
        goMenu.addItem(command("Forward", "forward", key: "]"))
        goMenu.addItem(.separator())
        goMenu.addItem(command("Search", "search", key: "f"))

        let tabs = tabs.prefix(9)
        if !tabs.isEmpty {
            goMenu.addItem(.separator())
            for (index, title) in tabs.enumerated() {
                goMenu.addItem(command(title, "tab", key: "\(index + 1)", index: index))
            }
        }
    }

    private func submenu(_ menu: NSMenu) -> NSMenuItem {
        let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
        item.submenu = menu
        return item
    }

    private func command(
        _ title: String,
        _ name: String,
        key: String,
        modifiers: NSEvent.ModifierFlags = .command,
        index: Int? = nil
    ) -> NSMenuItem {
        var properties: [String: Any] = ["name": name]
        if let index = index { properties["index"] = index }

        let item = NSMenuItem(title: title, action: #selector(performCommand(_:)), keyEquivalent: key)
        item.keyEquivalentModifierMask = modifiers
        item.representedObject = properties
        item.target = self
        return item
    }

    //
    // Performing
    //

    @objc private func performCommand(_ sender: NSMenuItem) {
        guard let properties = sender.representedObject as? [String: Any], let name = properties["name"] as? String else { return }

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
        // The same message a Dynamic Type change sends on iOS.
        webApp.sendToWindowListener("onPreferredFontSizeChange", args: "\(TextSizeAdjustment.preferredFontSize)")
    }

    /// Looks for a newer web bundle right now, and tells the web app how it
    /// goes so it can say so. A new bundle reloads the page when it lands, the
    /// same as one found by the periodic check.
    private func checkForUpdate() {
        guard usingCachedWebBundle, let bundle = (NSApp.delegate as? AppDelegate)?.webBundle else {
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

    //
    // Developer settings
    //

    /// Where the app loads from, which iOS keeps in the Settings app. Read at
    /// launch (see the app delegate's setupSettings), so changes wait for the
    /// next one.
    @objc private func showDeveloperSettings() {
        guard let window = webApp.view.window else { return }
        let defaults = UserDefaults.standard

        let useServer = NSButton(checkboxWithTitle: "Use development server", target: nil, action: nil)
        useServer.state = defaults.bool(forKey: "use_development_server") ? .on : .off
        let server = NSTextField(string: defaults.string(forKey: "development_server") ?? "")
        server.placeholderString = "http://nfarina.local:3102"
        let useBundle = NSButton(checkboxWithTitle: "Use cached web bundle", target: nil, action: nil)
        useBundle.state = defaults.bool(forKey: "use_cached_web_bundle") ? .on : .off

        let stack = NSStackView(views: [useServer, server, useBundle])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 80)
        server.widthAnchor.constraint(equalToConstant: 300).isActive = true

        let alert = NSAlert()
        alert.messageText = "Developer settings"
        alert.informativeText = "Now loading from \(clientUrl). Changes take effect the next time the app opens."
        alert.accessoryView = stack
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            guard response == .alertFirstButtonReturn else { return }
            defaults.set(useServer.state == .on, forKey: "use_development_server")
            defaults.set(server.stringValue, forKey: "development_server")
            defaults.set(useBundle.state == .on, forKey: "use_cached_web_bundle")
        }
    }
}
