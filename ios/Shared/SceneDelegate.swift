// @chatwing
import UIKit

/// Owns the app's window under the UIScene lifecycle (required by the iOS 26+
/// SDK — see TN3187). The heavy lifting still lives in `AppDelegate`, which
/// creates the shared `webAppController` in `didFinishLaunching`; the scene just
/// hosts it in a window and forwards scene-level lifecycle/deep-link events.
class SceneDelegate: UIResponder, UIWindowSceneDelegate {

    private let log = Logger(prefix: "scenedelegate")

    var window: UIWindow?

    private var appDelegate: AppDelegate? {
        UIApplication.shared.delegate as? AppDelegate
    }

    func scene(
        _ scene: UIScene,
        willConnectTo session: UISceneSession,
        options connectionOptions: UIScene.ConnectionOptions
    ) {
        guard let windowScene = scene as? UIWindowScene else { return }

        #if targetEnvironment(macCatalyst)
        // Just the traffic lights over our own content, like Music or Safari,
        // with the web's header sharing their row. The toolbar is empty; its
        // unified style is only there to make the title bar as tall as our
        // header, which centers the traffic lights on it. (The frosted band
        // that stayed under them was the web view's scroll edge effect, which
        // WebAppViewController turns off.)
        if let titlebar = windowScene.titlebar {
            titlebar.titleVisibility = .hidden
            titlebar.toolbar = NSToolbar(identifier: "main")
            titlebar.toolbarStyle = .unified
            titlebar.separatorStyle = .none
        }
        #endif

        let window = UIWindow(windowScene: windowScene)
        // The web controller is created in AppDelegate.didFinishLaunching, which
        // runs before any scene connects.
        window.rootViewController = appDelegate?.webAppController
        self.window = window
        window.makeKeyAndVisible()

        // Cold-launch universal links arrive here rather than via
        // application(_:continue:). (Push-notification taps are still delivered
        // to UNUserNotificationCenterDelegate.didReceive on the AppDelegate.)
        for activity in connectionOptions.userActivities {
            if let url = activity.webpageURL {
                log.info("Cold-launch universal link: \(url)")
                appDelegate?.webAppController?.handleDeepLink(link: url.absoluteString)
            }
        }
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        // Replaces AppDelegate.applicationWillEnterForeground under the scene
        // lifecycle (the app-delegate variant is no longer called).
        appDelegate?.handleEnterForeground()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        appDelegate?.handleEnterBackground()
    }

    // @chatwing:sceneLifecycle:start
    // @chatwing:sceneLifecycle:end

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        // Warm universal links (app already running) arrive here.
        if let url = userActivity.webpageURL {
            log.info("Continuing universal link: \(url)")
            appDelegate?.webAppController?.handleDeepLink(link: url.absoluteString)
        }
    }
}
