import UIKit
import UserNotifications

/// Where the web bundle comes from (`MIKS_HOST` in the project, through
/// Info.plist), unless Settings → Miks points it at a development server.
/// The terminals themselves are a Mac's: the page connects to one over
/// Tailscale, through its daemon's gateway (packages/daemon/server/Gateway.ts).
var clientUrl: String = {
    let host = Bundle.main.object(forInfoDictionaryKey: "MiksHost") as? String
    let resolved = host?.trimmingCharacters(in: .whitespaces) ?? ""
    if resolved.isEmpty { return "https://miks-app.nfarina.com" }
    return resolved.hasPrefix("http") ? resolved : "https://\(resolved)"
}()

/// Serve the web app from a bundle cached on device, refreshed in the
/// background, so opening Miks never waits on the network for its own UI.
var usingCachedWebBundle = true

/// The composition root, and the only native code that's Miks's own: the web
/// view, the bridge and the bundle are chatwing's shared shell (`ios/Shared`).
@main
class AppDelegate: UIResponder, UIApplicationDelegate, UNUserNotificationCenterDelegate, WebAppViewControllerDelegate, WebBundleDelegate {
    private let log = Logger(prefix: "appdelegate")

    var webAppController: WebAppViewController!
    var webBundle: WebBundle!

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        log.info("Application is launching.")
        setupSettings()
        setupNotifications()
        setupWebViewController()
        return true
    }

    //
    // Settings bundle
    //

    /// Applies Settings → Miks: a development server (Vite, on a Mac), and
    /// whether to use the cached bundle. iOS doesn't seed these defaults from
    /// the Settings bundle until that screen is visited.
    private func setupSettings() {
        UserDefaults.standard.register(defaults: [
            "use_development_server": false,
            "development_server": "http://air.local:2738",
            "use_cached_web_bundle": true,
        ])

        if UserDefaults.standard.bool(forKey: "use_development_server"),
           let server = UserDefaults.standard.string(forKey: "development_server"),
           !server.isEmpty {
            log.info("Using development server \(server)")
            clientUrl = server
        }

        usingCachedWebBundle = UserDefaults.standard.bool(forKey: "use_cached_web_bundle")

        // A dev server is served live; caching it defeats the point.
        if clientUrl.contains(".local") { usingCachedWebBundle = false }
    }

    //
    // Application state, from SceneDelegate (the scene lifecycle skips the
    // app delegate's own foreground and background callbacks).
    //

    func handleEnterForeground() {
        webBundle?.checkForNewBundle()
    }

    func handleEnterBackground() {}

    //
    // What the shell asks of an app that has accounts; Miks hasn't.
    //

    func webAppViewController(_ controller: WebAppViewController, didLoginWithToken token: String) {}
    func webAppViewControllerDidLogout(_ controller: WebAppViewController) {}
    func webAppViewControllerDidRequestMicrophoneAuthorization(_ controller: WebAppViewController) {}

    //
    // Notifications: a Mac's daemon pushes (packages/daemon/server/Push.ts),
    // through the relay that holds the key (push/worker.js). The page
    // registers this device's token there and with every Mac, and asks for
    // permission once it has a Mac to hear from.
    //

    func setupNotifications() {
        // Push doesn't work on the simulator at all.
        if Platform.isSimulator { return }
        UNUserNotificationCenter.current().delegate = self
        registerIfAllowed()
    }

    private func registerIfAllowed() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func webAppViewControllerDidRequestNotificationAuthorization(_ controller: WebAppViewController) {
        if Platform.isSimulator { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            self.log.info("Notifications granted? \(granted) \(String(describing: error))")
            self.registerIfAllowed()
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        log.info("Remote notification registration succeeded.")
        MiksPlugin.pushToken = deviceToken.apnsToken
        webAppController?.sendToWindowListener("miks_pushToken", args: MiksPlugin.pushInfoJSON)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        log.error("Remote notification registration failed.", error)
    }

    // With the app in front, a push is from a Mac other than the one on
    // screen (the daemon never pushes to the device showing it): show it.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.list, .banner, .sound])
    }

    // The tab was looked at somewhere: its notification goes.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        if AppNotifications.handleRemoteNotification(userInfo, completion: { completionHandler(.noData) }) { return }
        completionHandler(.noData)
    }

    // Tapped: open its tab, now or once the page asks (launched by the tap).
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        if response.actionIdentifier == UNNotificationDefaultActionIdentifier,
           let mac = userInfo["mac"] as? String, let tabId = userInfo["tabId"] as? String {
            MiksPlugin.pendingNotification = ["mac": mac, "tabId": tabId]
            if webAppController?.isLoaded() == true, let json = MiksPlugin.takePendingNotificationJSON() {
                webAppController.sendToWindowListener("miks_openNotification", args: json)
            }
        }
        completionHandler()
    }

    //
    // Web view
    //

    func setupWebViewController() {
        webAppController = WebAppViewController()
        webAppController.delegate = self

        guard usingCachedWebBundle else {
            webAppController.load(URLString: clientUrl)
            return
        }

        webBundle = WebBundle(delegate: self)

        // From crosswing://app/, a real origin (file:// pages have a null one),
        // and the one the gateway lets this app's page connect from.
        if webBundle.localBundleExists {
            webAppController.load(URLString: webBundle.applicationURL)
        }
        // Otherwise the first download's progress shows until it lands.
    }

    //
    // Web bundle
    //

    func webBundleDidMakeProgress(progress: Float) {
        if !webAppController.isLoaded() {
            webAppController.setLoadProgress(progress)
        }
    }

    func webBundleDidDownloadNewBundle(_ bundle: WebBundle) {
        if webAppController.isLoaded() {
            webAppController.reload()
        } else {
            webAppController.load(URLString: bundle.applicationURL)
        }
        webAppController.setLoadProgress(nil)
    }

    func webBundleUpToDate(_ bundle: WebBundle) {}

    func webBundleDidFailDownloadingNewBundle(_ bundle: WebBundle) {
        log.warn("Couldn't download a new web bundle.")
    }

    //
    // Keyboard shortcuts: the Mac app's menu (packages/app/main.ts), for a
    // hardware keyboard. Listed in the menu bar (iPadOS 26) and the list
    // holding ⌘ shows; each goes to the page as the command its menu sends.
    //

    private static let commands: [(menu: UIMenu.Identifier, items: [(String, String, UIKeyModifierFlags, String)])] = [
        (.file, [
            ("New tab", "t", .command, "newTab"),
            ("New workspace", "n", .command, "newWorkspace"),
            ("Close tab", "w", .command, "closeTab"),
            ("Close workspace", "w", [.command, .alternate], "closeWorkspace"),
        ]),
        (.edit, [
            ("Select last command", "a", [.command, .shift], "selectLastCommand"),
            ("Clear to start", "k", .command, "clearToStart"),
        ]),
        (.view, [
            ("Toggle sidebar", "b", .command, "toggleSidebar"),
            ("Toggle panel", "c", [.command, .shift], "toggleChat"),
            ("Panel fills the tab", "f", [.command, .shift], "toggleExpanded"),
            ("Bigger text", "=", .command, "fontBigger"),
            ("Smaller text", "-", .command, "fontSmaller"),
            ("Actual size", "0", .command, "fontReset"),
        ]),
        (.window, [
            ("Next tab", "]", [.command, .shift], "nextTab"),
            ("Previous tab", "[", [.command, .shift], "previousTab"),
            ("Next workspace", "]", [.command, .control], "nextWorkspace"),
            ("Previous workspace", "[", [.command, .control], "previousWorkspace"),
        ] + (1...9).map { ("Workspace \($0)", "\($0)", UIKeyModifierFlags.command, "workspace\($0)") }),
    ]

    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .main else { return }

        // The system's own, on keys these need: Bold (⌘B), text size (⌘+, ⌘−),
        // New Window (⌘N), Close (⌘W), and Find, which drives a bar there isn't.
        for menu: UIMenu.Identifier in [.format, .newScene, .close, .find] {
            builder.remove(menu: menu)
        }

        // What `miks version` says, as the Mac app's About Miks shows it.
        let about = UICommand(title: "About Miks", action: #selector(runMiksCommand(_:)), propertyList: "versions")
        builder.replace(menu: .about, with: UIMenu(identifier: .about, options: .displayInline, children: [about]))

        let settings = UIKeyCommand(title: "Settings…", action: #selector(runMiksCommand(_:)), input: ",", modifierFlags: .command, propertyList: "settings")
        builder.insertSibling(UIMenu(options: .displayInline, children: [settings]), afterMenu: .about)

        for (menu, items) in AppDelegate.commands {
            let children = items.map { title, input, modifiers, command in
                UIKeyCommand(title: title, action: #selector(runMiksCommand(_:)), input: input, modifierFlags: modifiers, propertyList: command)
            }
            builder.insertChild(UIMenu(identifier: UIMenu.Identifier("com.nfarina.miks.\(menu.rawValue)"), options: .displayInline, children: children), atStartOfMenu: menu)
        }
    }

    @objc func runMiksCommand(_ sender: UICommand) {
        guard let command = sender.propertyList as? String else { return }
        webAppController?.sendToWindowListener("miks_command", args: "\"\(command)\"")
    }

    //
    // Scene lifecycle
    //

    func application(
        _ application: UIApplication,
        configurationForConnecting connectingSceneSession: UISceneSession,
        options: UIScene.ConnectionOptions
    ) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
    }
}
