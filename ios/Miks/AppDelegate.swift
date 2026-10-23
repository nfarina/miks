import UIKit

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
class AppDelegate: UIResponder, UIApplicationDelegate, WebAppViewControllerDelegate, WebBundleDelegate {
    private let log = Logger(prefix: "appdelegate")

    var webAppController: WebAppViewController!
    var webBundle: WebBundle!

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        log.info("Application is launching.")
        setupSettings()
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
    // What the shell asks of an app that has accounts and push; Miks has neither yet.
    //

    func webAppViewController(_ controller: WebAppViewController, didLoginWithToken token: String) {}
    func webAppViewControllerDidLogout(_ controller: WebAppViewController) {}
    func webAppViewControllerDidRequestNotificationAuthorization(_ controller: WebAppViewController) {}
    func webAppViewControllerDidRequestMicrophoneAuthorization(_ controller: WebAppViewController) {}

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
