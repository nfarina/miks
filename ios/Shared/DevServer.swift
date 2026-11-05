// @chatwing
import Foundation
#if os(iOS)
import UIKit
#endif

/// Pointing the app at a development server instead of production, and back,
/// without restarting it.
///
/// The choice lives in the same defaults the Settings app edits
/// (`use_development_server`, `development_server`), so a custom address
/// typed there still works, and is picked up on returning to the app. The
/// quick ways in - home screen quick actions and `<scheme>://dev-server/…`
/// links - only work in Developer mode, which only the Settings app can turn
/// on: a link that could point the app anywhere would hand that server the
/// user's session.
///
/// The servers on offer are the `DevServers` URLs in Info.plist, each named by
/// its first host label (`https://neo.example.ts.net:7202` is "neo"). Those are
/// live Vite servers. A server can instead serve a packaged bundle for the app
/// to cache (`bundle=1` on a link), which keeps working away from the laptop;
/// that's what ios/point.sh hands over by default.
///
/// A live Vite server can also be told which backend to use: production, the
/// machine's local server against production data, or its emulators. That's
/// the web app's `emulator=` param, which it remembers until told otherwise.
enum DevServer {
    /// The web app's `emulator=` values, as offered when picking a preset.
    enum Backend: String, CaseIterable {
        case none, functions, firestore

        var title: String {
            switch self {
            case .none: "Production backend"
            case .functions: "Local functions (production data)"
            case .firestore: "Emulator (local functions + Firestore)"
            }
        }

        var shortTitle: String {
            switch self {
            case .none: "Production backend"
            case .functions: "Local functions"
            case .firestore: "Emulator"
            }
        }
    }

    /// Posted after switching servers. The app delegate starts (or stops) its
    /// WebBundle, since a bundle server's bundle should be downloaded now, so
    /// the app keeps working once the server is out of reach.
    static let didChangeNotification = Notification.Name("DevServerDidChange")

    private static let log = Logger(prefix: "devserver")
    private static var defaults: UserDefaults { .standard }

    /// What the app ships pointed at. Captured on first use, which
    /// `applySettings()` makes sure comes before anything changes `clientUrl`.
    private static let productionURL = clientUrl

    static var isDeveloperMode: Bool { defaults.bool(forKey: "developer_mode") }

    static var presets: [(name: String, url: String)] {
        let urls = Bundle.main.object(forInfoDictionaryKey: "DevServers") as? [String] ?? []
        return urls.compactMap { url in
            guard let host = URL(string: url)?.host, let name = host.split(separator: ".").first else { return nil }
            return (String(name), url)
        }
    }

    /// The development server in use, or nil for production.
    static var current: String? {
        guard defaults.bool(forKey: "use_development_server"),
              let server = defaults.string(forKey: "development_server"),
              !server.isEmpty
        else { return nil }
        return server
    }

    /// The backend picked for the current live server, if any.
    static var backend: Backend? {
        guard current != nil, !usingCachedWebBundle else { return nil }
        return defaults.string(forKey: "development_server_backend").flatMap(Backend.init)
    }

    /// Where to load the web app from at launch. The web app keeps its backend
    /// in session storage, which doesn't outlive the process, so it's told
    /// again every time.
    static var launchURL: String {
        backend.map { "\(clientUrl)/?emulator=\($0.rawValue)" } ?? clientUrl
    }

    /// Points `clientUrl` (and bundle caching) at the saved choice. Returns
    /// whether that changed anything.
    @discardableResult
    static func applySettings() -> Bool {
        let before = (clientUrl, usingCachedWebBundle)
        let production = productionURL

        clientUrl = current ?? production
        usingCachedWebBundle = defaults.bool(forKey: "use_cached_web_bundle")

        // So anyone can see where a device is pointed without asking.
        Device.update(["server": clientUrl, "cachedBundle": usingCachedWebBundle])

        return before != (clientUrl, usingCachedWebBundle)
    }

    /// Re-reads the settings, as they may have been changed in the Settings
    /// app, and reloads the web app if they now point somewhere else.
    static func applySettingsIfChanged(webApp: WebAppViewController?) {
        if applySettings() {
            // A backend was picked for whatever was chosen before.
            defaults.removeObject(forKey: "development_server_backend")
            log.info("Settings changed; now loading from \(clientUrl)")
            webApp?.load(URLString: clientUrl)
            NotificationCenter.default.post(name: didChangeNotification, object: nil)
        }
        #if os(iOS)
        updateShortcutItems()
        #endif
    }

    /// Switches to `server` (nil for production) and reloads the web app from
    /// it, opening `path` if given. `bundle` says whether to cache its packaged
    /// bundle rather than load it live; nil leaves that as it was.
    /// `backend` picks one for a live server; nil leaves it as the web app last
    /// had it.
    static func select(
        _ server: String?, bundle: Bool?, backend: Backend? = nil, path: String? = nil,
        webApp: WebAppViewController?
    ) {
        defaults.set(server != nil, forKey: "use_development_server")
        if let server { defaults.set(server, forKey: "development_server") }
        if let bundle { defaults.set(bundle, forKey: "use_cached_web_bundle") }

        // Only a live server can use the emulators, and only one we chose for
        // it is worth labeling.
        if server == nil || bundle == true || backend != nil {
            defaults.set(backend?.rawValue, forKey: "development_server_backend")
        }

        applySettings()
        log.info("Now loading from \(clientUrl)")

        // Loads off the network for now. For a bundle server, the app delegate
        // swaps in the cached copy once it's downloaded (or found up to date).
        var path = path.map { $0.hasPrefix("/") ? $0 : "/\($0)" } ?? ""
        if let backend {
            if path.isEmpty { path = "/" }
            path += (path.contains("?") ? "&" : "?") + "emulator=\(backend.rawValue)"
        }
        webApp?.load(URLString: clientUrl + path)
        NotificationCenter.default.post(name: didChangeNotification, object: nil)

        #if os(iOS)
        updateShortcutItems()
        #endif
    }

    /// Handles `<scheme>://dev-server/<name>`, where the name is a preset or
    /// "production"; `<scheme>://dev-server?url=<url>` for any other server,
    /// with `bundle=1` if it serves a bundle to cache; `path=` with any of
    /// them to open a page there; and `emulator=none|functions|firestore` for a
    /// live server's backend. Returns false for any other URL.
    static func handle(url: URL, webApp: WebAppViewController?) -> Bool {
        guard url.host == "dev-server" else { return false }

        guard isDeveloperMode else {
            log.warn("Ignoring \(url) outside Developer mode.")
            return true
        }

        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let path = query.first { $0.name == "path" }?.value
        let bundle = query.first { $0.name == "bundle" }?.value == "1"
        let backend = query.first { $0.name == "emulator" }?.value.flatMap(Backend.init)
        let name = url.pathComponents.dropFirst().first

        if name == "production" {
            select(nil, bundle: true, path: path, webApp: webApp)
        } else if let preset = presets.first(where: { $0.name == name }) {
            select(preset.url, bundle: false, backend: backend, path: path, webApp: webApp)
        } else if let server = query.first(where: { $0.name == "url" })?.value {
            select(server, bundle: bundle, backend: bundle ? nil : backend, path: path, webApp: webApp)
        } else {
            log.warn("No development server matches \(url).")
        }
        return true
    }

    #if os(iOS)
    private static let shortcutType = "dev-server"

    /// Lists the servers as home screen quick actions while in Developer mode,
    /// leaving any other quick actions the app has alone.
    static func updateShortcutItems() {
        var choices: [(title: String, url: String?)] = [("Production", nil)]
        choices += presets.map { (title: $0.name, url: Optional($0.url)) }

        // A custom address from the Settings app, so it's one tap to go back.
        if let server = defaults.string(forKey: "development_server"), !server.isEmpty,
           !presets.contains(where: { $0.url == server }) {
            choices.append(("Custom", server))
        }

        let current = self.current
        let backend = self.backend
        let ours = isDeveloperMode
            ? choices.map { choice in
                UIApplicationShortcutItem(
                    type: shortcutType,
                    localizedTitle: choice.title,
                    localizedSubtitle: choice.url != current ? nil
                        : backend.map { "Current · \($0.shortTitle)" } ?? "Current server",
                    icon: UIApplicationShortcutIcon(systemImageName: choice.url == current ? "checkmark.circle" : "server.rack"),
                    userInfo: choice.url.map { ["url": $0 as NSString] }
                )
            }
            : []

        let others = (UIApplication.shared.shortcutItems ?? []).filter { $0.type != shortcutType }
        UIApplication.shared.shortcutItems = others + ours
    }

    /// Returns false for any other quick action.
    static func handle(shortcutItem: UIApplicationShortcutItem, webApp: WebAppViewController?) -> Bool {
        guard shortcutItem.type == shortcutType else { return false }
        guard isDeveloperMode else { return true }

        // Production and the presets have a known kind; a custom server keeps
        // whatever the Settings app says.
        let server = shortcutItem.userInfo?["url"] as? String
        if let server, let preset = presets.first(where: { $0.url == server }) {
            chooseBackend(name: preset.name, server: server, webApp: webApp)
        } else {
            select(server, bundle: server == nil ? true : nil, webApp: webApp)
        }
        return true
    }

    /// Asks which backend a preset's live server should use, then switches.
    /// Quick actions can't have submenus, and a preset per backend would push
    /// past the four the home screen shows.
    private static func chooseBackend(
        name: String, server: String, webApp: WebAppViewController?, attempts: Int = 10
    ) {
        guard let webApp else { return }

        // At launch from a quick action, the web app isn't on screen yet.
        guard webApp.viewIfLoaded?.window != nil else {
            guard attempts > 0 else { return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                chooseBackend(name: name, server: server, webApp: webApp, attempts: attempts - 1)
            }
            return
        }

        var presenter: UIViewController = webApp
        while let presented = presenter.presentedViewController { presenter = presented }

        let sheet = UIAlertController(title: name, message: nil, preferredStyle: .actionSheet)
        for backend in Backend.allCases {
            sheet.addAction(UIAlertAction(title: backend.title, style: .default) { _ in
                select(server, bundle: false, backend: backend, webApp: webApp)
            })
        }
        sheet.addAction(UIAlertAction(title: "Cancel", style: .cancel))

        // An iPad shows it as a popover, which needs somewhere to point.
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 0, height: 0)
            popover.permittedArrowDirections = []
        }
        presenter.present(sheet, animated: true)
    }
    #endif
}
