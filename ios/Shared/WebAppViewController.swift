// @chatwing
import UIKit
@preconcurrency import WebKit
#if canImport(FirebaseAuth)
import FirebaseAuth
#endif
import UserNotifications
import MessageUI
import StoreKit

protocol WebAppViewControllerDelegate {
    func webAppViewController(_ controller: WebAppViewController, didLoginWithToken token:String)
    func webAppViewControllerDidLogout(_ controller: WebAppViewController)
    func webAppViewControllerDidRequestNotificationAuthorization(_ controller: WebAppViewController)
    func webAppViewControllerDidRequestMicrophoneAuthorization(_ controller: WebAppViewController)
}

class WebAppViewController:
    UIViewController,
    UIScrollViewDelegate,
    WKScriptMessageHandler,
    WKUIDelegate,
    WKNavigationDelegate,
    MFMessageComposeViewControllerDelegate,
    MFMailComposeViewControllerDelegate
{
    
    private let log = Logger(prefix: "webapp")
    
    var delegate:WebAppViewControllerDelegate?
    
    private var pendingURLString: String?
    private var currentURL: URL?
    private var statusBarStyle: UIStatusBarStyle = .default
    private var pendingDeepLink: String?
    
    private var webView: WKWebView!

    /// Points per CSS pixel, for plugins trading lengths with the web.
    var pageZoom: CGFloat { webView.pageZoom }
    private let layoutObserver = LayoutObserver()
    private var loadingView:UIProgressView?
    private var loadProgress: Float? = nil
    private var featuresRequested: Bool = false
    
    // Array of loaded plugins.
    private var plugins: [WebAppPlugin] = []
    
    override func loadView() {
        
        #if !os(visionOS)
        // Make launch screen remain visible until the web content is ready.
        let storyboard = UIStoryboard(name: "LaunchScreen", bundle: nil)
        let launchViewController = storyboard.instantiateViewController(withIdentifier: "controller")
        let launchView = launchViewController.view!
        launchViewController.view = nil // disconnect the view from its original controller
        
        self.view = launchView
        
        // We tagged the UIProgressView in our storyboard so we can update it later.
        let loadingView = launchView.viewWithTag(1) as! UIProgressView
        loadingView.progress = 0 // Reset storyboard value
        
        // Do we have progress to show already?
        if let progress = loadProgress {
            loadingView.isHidden = false
            loadingView.setProgress(progress, animated: false)
        }
        
        self.loadingView = loadingView
        #else
        self.view = UIView()
        #endif

        // Catches taps on the status bar (see layoutScrollToTopTraps).
        layoutScrollToTopTraps()
        
        // Build the web view.
        let userController = WKUserContentController()
        userController.add(self, name: "default")
        let webConfig:WKWebViewConfiguration = WKWebViewConfiguration()
        webConfig.userContentController = userController

        // Serve the cached bundle over a real origin rather than file://.
        // Registering the handler is harmless whether or not this app loads
        // from it — it only answers crosswing:// requests, and must be set on
        // the configuration before the web view is created.
        webConfig.setURLSchemeHandler(
            WebBundleSchemeHandler(rootDirectory: { WebBundle.distDirectory }),
            forURLScheme: WebBundleScheme
        )
        // @chatwing:scheme-handlers:start
        // @chatwing:scheme-handlers:end
        
        // Allow audio recording and playback.
        webConfig.allowsInlineMediaPlayback = true
        webConfig.mediaTypesRequiringUserActionForPlayback = []
        
        webView = WKWebView(frame: CGRect.zero, configuration: webConfig)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.removeInputAccessoryView()

        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        
        webView.frame = self.view.bounds
        webView.scrollView.delegate = self
        webView.scrollView.bounces = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #if targetEnvironment(macCatalyst)
        // On a Mac, the 26-era scroll edge effect draws a frosted band and a
        // hard line wherever content meets the title bar, so it read as a
        // title bar that went opaque once our header filled in. The page
        // scrolls itself and draws its own header, so turn it off.
        if #available(macCatalyst 26.0, *) {
            webView.scrollView.topEdgeEffect.isHidden = true
        }
        #endif
        
        self.view.addSubview(webView)

        // macOS draws the iPad app at 77%, which leaves the whole UI small next
        // to native Mac apps (a nav button lands smaller than Finder's). Page
        // zoom scales it back up the way Safari's ⌘+ does, so CSS pixels, rects
        // and viewport units all stay consistent — unlike CSS `zoom`, which
        // double-scales anything positioned from getBoundingClientRect.
        if ProcessInfo.processInfo.isiOSAppOnMac {
            webView.pageZoom = 1.15
        }

        #if targetEnvironment(macCatalyst)
        // The Mac app draws 1px as 1pt, which leaves the whole UI a little
        // big instead: a nav button lands at 41.5pt next to Finder's 37pt.
        // This is that ratio.
        webView.pageZoom = 0.89
        #endif

        layoutObserver.pointsPerCSSPixel = webView.pageZoom

        // Reports layout signals (size classes, safe areas, the fold, which
        // edge bars go on) to the web app as they change.
        layoutObserver.frame = self.view.bounds
        layoutObserver.onChange = { [weak self] layout in
            guard let self, self.featuresRequested else { return }
            self.sendToWindowListener("onLayoutChange", args: self.encodeJSON(layout))
        }
        self.view.addSubview(layoutObserver)

        // Lets clicks reach the web's buttons up in the Mac window's title bar.
        #if targetEnvironment(macCatalyst)
        plugins.append(TitlebarPlugin(webApp: self))
        // The menu bar and its keyboard shortcuts.
        plugins.append(MenuPlugin(webApp: self))
        #endif

        // Which plugins an app loads is the one genuinely per-app part of this
        // file — everything else here is shared, and where projects differ it
        // is because one is behind rather than because it wants to be.
        // @chatwing:plugins:start
        plugins.append(MiksPlugin(webApp: self))
        // @chatwing:plugins:end

        NotificationCenter.default.addObserver(self, selector: #selector(applicationWillEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationDidBecomeActive), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationWillResignActive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(applicationDidEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)

        // Dynamic Type changes — observing the notification works on all iOS
        // versions, unlike overriding the (iOS 17-deprecated) traitCollectionDidChange.
        NotificationCenter.default.addObserver(self, selector: #selector(contentSizeCategoryDidChange), name: UIContentSizeCategory.didChangeNotification, object: nil)
    }
    
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide), name: UIResponder.keyboardWillHideNotification, object: nil)
        // Undocking, floating, or resizing the keyboard (iPad) changes how much of us it covers.
        NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillShow), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }
    
    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        // Only the keyboard's: the app lifecycle observers from viewDidLoad
        // must outlive a full-screen controller presented over us, or a web
        // view terminated in the background never reloads.
        NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillShowNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillHideNotification, object: nil)
        NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    }
    
    override var preferredStatusBarStyle: UIStatusBarStyle {
        return statusBarStyle
    }
    
    //
    // Public Methods
    //

    @objc func load(URLString: String) {
        
        if UIApplication.shared.applicationState != .background {
            reallyLoad(URLString: URLString)
        }
        else {
            log.info("Deferring loading until foreground for URL: \(URLString)")
            pendingURLString = URLString
        }
    }
    
    func setLoadProgress(_ progress: Float?) {
        self.loadProgress = progress
        
        // If our view isn't loaded then we can't apply this progress right now; it'll happen in loadView().
        guard let loadingView = self.loadingView else { return }
        
        if let progress = progress {
            loadingView.isHidden = false
            loadingView.setProgress(progress, animated: true)
        }
        else {
            loadingView.isHidden = true
        }
    }
    
    //
    // Foreground Web View Loading
    //
    
    @objc func applicationWillEnterForeground() {
        if let URLString = pendingURLString {
            pendingURLString = nil
            reallyLoad(URLString: URLString)
        }
    }
    
    func reallyLoad(URLString: String) {
        
        // Reset this in case the web view reloaded while viewing a screen that was keeping the display on.
        UIApplication.shared.isIdleTimerDisabled = false
        
        currentURL = URL(string: URLString)
        guard let url = currentURL else { return }
        
        log.info("Loading URL: \(url)")
        loadViewIfNeeded()
        featuresRequested = false

        // loadFileURL is only for file://; a custom scheme goes through the
        // normal load path and is answered by our scheme handler.
        if URLString.hasPrefix("file://") {
            let baseURL = URL(string: URLString.replacingOccurrences(of: "index.html", with: ""))
            webView.loadFileURL(url, allowingReadAccessTo: baseURL!)
        }
        else {
            webView.load(URLRequest(url: url))
        }
    }
    
    func isLoaded() -> Bool {
        return currentURL != nil
    }
    
    func reload() {
        // Check if we have paused updates.
        if let pauseReloadUntil = pauseReloadUntil {
            if pauseReloadUntil > Date() {
                let formatter = ISO8601DateFormatter()
                formatter.timeZone = TimeZone.current
                let untilStr = formatter.string(from: pauseReloadUntil)
                log.info("Deferring reload until \(untilStr)")
                reloadPending = true
                return
            }
        }

        featuresRequested = false
        webView.reload()
    }
    
    //
    // Script Handler
    //
    
    /// Presents the system print sheet for a page in the web app. See
    /// WebPrintJob for why this renders the page a second time, offscreen,
    /// rather than printing the web view the user is looking at.
    func printUrl(_ urlString: String, jobName: String, callback: String?) {
        log.info("Printing url: \"\(urlString)\"")

        guard let url = URL(string: urlString) else {
            log.error("Could not parse url to print: \"\(urlString)\"")
            if let callback = callback {
                executeJSCallback(callback, result: ["error": "That page can't be printed."])
            }
            return
        }

        // The print layouts are rendered by the web app, which has no browser
        // print mode to notice when it's offscreen. This is how it knows to
        // render itself for paper.
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        let existingQuery = components?.queryItems ?? []
        components?.queryItems = existingQuery + [URLQueryItem(name: "print", value: "1")]

        WebPrintJob(url: components?.url ?? url, jobName: jobName, presenter: self) { error in
            guard let callback = callback else { return }
            if let error = error {
                self.executeJSCallback(callback, result: ["error": error])
            } else {
                self.executeJSCallback(callback)
            }
        }.start()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        
        if message.name == "error" {
            let error = (message.body as? [String: Any])?["message"] as? String ?? "unknown"
            log.error(error)
        }
        
        guard message.name == "default" else { return }
        
        let body = message.body as! [String: Any]
        let name = body["name"] as! String
        let pluginName = body["plugin"] as? String
        
        // If you asked to send the message to a plugin, then look it up
        // and if we have it, send the message there.
        if let pluginName = pluginName {
            for plugin in plugins {
                if plugin.name == pluginName {
                    let handled = plugin.handleMessage(name: name, body: body)
                    if (!handled) {
                        log.error("Plugin \(pluginName) did not handle message: \(name)")
                    }
                    return
                }
            }
            log.error("Plugin not found: \(pluginName)")
            return
        }

        switch name {
        case "getFeatures":
            let callback = body["callback"] as! String
            
            // Now we know the webapp is loaded and ready to receive JS event hooks.
            featuresRequested = true

            #if targetEnvironment(macCatalyst)
            // Nothing in a Mac window has the keyboard until it's clicked, so
            // the page's own keys would do nothing at launch (or after a
            // reload, which starts the web view over).
            if presentedViewController == nil {
                webView.becomeFirstResponder()
            }
            #endif

            var result = [
                "identifier": DeviceIdentifier(),
                "clientUrl": clientUrl,
                "webBundle": usingCachedWebBundle,
                "login": true,
                "notifications": !Platform.isSimulator,
                "notificationAuthorization": !Platform.isSimulator,
                "safeArea": Platform.supportsSafeArea,
                "clipboard": true,
                "clipboardRead": true,
                "shareSheet": true,
                "fileShare": true,
                "print": UIPrintInteractionController.isPrintingAvailable,
                "messageSheet": MFMessageComposeViewController.canSendText(),
                "emailSheet": MFMailComposeViewController.canSendMail(),
                "preferredFontSize": TextSizeAdjustment.preferredFontSize,
                "wakeLock": true,
                "brightness": true,
                "reviewPrompt": true,
                ] as [String : Any]

            if let layout = layoutObserver.layout {
                result["layout"] = layout
            }

            #if os(visionOS)
            result["platform"] = "visionOS"
            #elseif targetEnvironment(macCatalyst)
            // The Mac app. Its Mac interface draws 1 CSS px as 1pt (no 77%
            // shrink), and reports a 13pt body font rather than iOS's 17.
            result["platform"] = "macOS"
            #else
            // The iPad app running on an Apple Silicon Mac ("Designed for
            // iPad"), which we page-zoom up to offset macOS drawing it at 77%.
            if ProcessInfo.processInfo.isiOSAppOnMac {
                result["platform"] = "iOSAppOnMac"
            }
            #endif
            
            if let pendingDeepLink = self.pendingDeepLink {
                result["pendingDeepLink"] = pendingDeepLink
                
                // Clear this out after requesting it the first time - if the app reloads for some reason, we don't want it to keep
                // grabbing the link over and over.
                self.pendingDeepLink = nil
            }

            // Add the names of any plugins that are loaded to a "plugins" map
            // where the values are the result of the "features" property on
            // the plugin.
            var plugins = [String: Any]()
            for plugin in self.plugins {
                plugins[plugin.name] = plugin.features
            }
            result["plugins"] = plugins
            
            self.executeJSCallback(callback, result: result)

        case "log":
            let prefix = body["prefix"] as? String
            let message = body["message"] as! String
            log.info(message, prefix: prefix)
            
        case "openUrl":
            let url = body["url"] as! String
            UIApplication.shared.open(URL(string: url)!)
            
        case "login":
            if let token = body["token"] as? String {
                delegate?.webAppViewController(self, didLoginWithToken: token)
            }
            
        case "logout":
            delegate?.webAppViewControllerDidLogout(self)
        
        #if !os(visionOS)
        case "onStatusBarStyleChange":
            let style = body["style"] as! String
            statusBarStyle = style == "light" ? .lightContent : .default
            setNeedsStatusBarAppearanceUpdate()
            
        case "setWakeLock":
            let wakeLock = body["on"] as! Bool
            UIApplication.shared.isIdleTimerDisabled = wakeLock
            log.info("Setting idle timer to disabled = \(wakeLock)")
        
        case "getBrightness":
            let callback = body["callback"] as! String
            let brightness = Double(UIScreen.main.brightness)
            self.executeJSCallback(callback, result: [
                "level": brightness as AnyObject
            ])
            
        case "setBrightness":
            let brightness = body["level"] as! Double
            log.info("Setting brightness to \(brightness)")
            UIScreen.main.brightness = CGFloat(brightness)
        #endif
        
        case "requestNotificationAuthorization":
            delegate?.webAppViewControllerDidRequestNotificationAuthorization(self)
            
        case "requestMicrophoneAuthorization":
            delegate?.webAppViewControllerDidRequestMicrophoneAuthorization(self)

        case "openSettings":
            UIApplication.shared.open(URL(string: UIApplication.openSettingsURLString)!)

        case "requestReview":
            // Best-effort native star-rating dialog. Apple rate-limits it
            // (~3×/year) and decides whether to actually show it, so the web
            // side always offers a write-review link as a guaranteed fallback.
            if let windowScene = view.window?.windowScene {
                log.info("Requesting App Store review")
                AppStore.requestReview(in: windowScene)
            } else {
                log.warn("requestReview: no window scene available")
            }

        case "badgeAppIcon":
            let badge = body["badge"] as! Int
            log.debug("Setting application icon badge to \(badge)")
            UNUserNotificationCenter.current().setBadgeCount(badge)
            lastAppIconBadge = badge
            
        case "copyToClipboard":
            let text = body["text"] as! String
            log.info("Copying to clipboard: \"\(text)\"")
            UIPasteboard.general.string = text

        case "readClipboard":
            // Reading UIPasteboard.general.string triggers the system "Allow
            // Paste" prompt automatically on iOS 16+, so we just read and
            // return whatever the user permits (empty string if denied/empty).
            let callback = body["callback"] as! String
            let text = UIPasteboard.general.string ?? ""
            log.info("Reading from clipboard (\(text.count) chars)")
            self.executeJSCallback(callback, result: ["text": text])

        case "showShareSheet":
            let text = body["text"] as! String
            log.info("Showing share sheet for text: \"\(text)\"")
            // A link shared as a String arrives in Messages as plain text: no
            // preview, and nothing the receiving app will turn into a tap
            // target. Handing over the URL itself is what makes it a link.
            var item: Any = text
            if let url = URL(string: text), url.scheme == "https" || url.scheme == "http" {
                item = url
            }
            let controller = UIActivityViewController(activityItems: [item], applicationActivities: nil)
            anchorForIPad(controller)
            present(controller, animated: true)

        case "shareFile":
            let base64 = body["data"] as! String
            let fileName = body["fileName"] as! String
            // Optional callback so the webapp can show a working state until the
            // share sheet is actually on screen.
            let callback = body["callback"] as? String
            log.info("Sharing file: \"\(fileName)\"")
            if let data = Data(base64Encoded: base64) {
                // Write to a temp file so the share sheet can offer "Save to
                // Files", AirDrop, Mail, etc. with a real file (and filename).
                let tmpURL = FileManager.default.temporaryDirectory.appendingPathComponent(fileName)
                do {
                    try data.write(to: tmpURL)
                    let controller = UIActivityViewController(activityItems: [tmpURL], applicationActivities: nil)
                    anchorForIPad(controller)
                    present(controller, animated: true) {
                        // Sheet is presented; let the webapp clear its spinner.
                        if let callback = callback {
                            self.executeJSCallback(callback)
                        }
                    }
                } catch {
                    log.error("Failed to write file for sharing: \(error.localizedDescription)")
                    if let callback = callback {
                        self.executeJSCallback(callback, result: ["error": error.localizedDescription])
                    }
                }
            } else {
                log.error("Could not decode base64 data for file: \"\(fileName)\"")
                if let callback = callback {
                    self.executeJSCallback(callback, result: ["error": "Could not decode file data."])
                }
            }

        case "printUrl":
            // Optional callback so the webapp can show a working state until
            // the print sheet is actually on screen — loading and rendering the
            // page first takes a moment.
            printUrl(
                body["url"] as! String,
                jobName: body["jobName"] as? String ?? "Document",
                callback: body["callback"] as? String
            )

        case "showMessageSheet":
            let to = body["to"] as! String
            let message = body["body"] as! String
            log.info("Showing message sheet for recipient: \"\(to)\"")
            let controller = MFMessageComposeViewController()
            controller.body = message
            controller.recipients = [to]
            controller.messageComposeDelegate = self
            present(controller, animated: true)

        case "showEmailSheet":
            let to = body["to"] as! String
            let subject = body["subject"] as! String
            let message = body["body"] as! String
            let isHTML = body["isHTML"] as! Bool
            log.info("Showing email sheet for recipient: \"\(to)\"")
            let controller = MFMailComposeViewController()
            controller.setMessageBody(message, isHTML: isHTML)
            controller.setSubject(subject)
            controller.setToRecipients([to])
            controller.mailComposeDelegate = self
            present(controller, animated: true)

        case "startSmsRetriever":
            log.info("Ignoring startSmsRetriever command.")
        
        case "delayUpdates":
            let duration = body["duration"] as! Int
            if (duration > 0) {
                delayUpdates(duration: duration)
            }
            else {
                resumeUpdates()
            }
        
        case "windowListenerCallback":
            executeSwiftCallback(body)            

        default:
            log.error("Unknown script message \(name)")
        }
    }

    /// Required on iPad, where a share sheet presents as a popover and UIKit
    /// raises (crashing the app) if it has nothing to point at. The IPC gives
    /// us no rect for the button that was tapped, so we center it over the web
    /// view and drop the arrow.
    func anchorForIPad(_ controller: UIViewController) {
        guard let popover = controller.popoverPresentationController else { return }
        popover.sourceView = self.view
        popover.sourceRect = CGRect(x: self.view.bounds.midX, y: self.view.bounds.midY, width: 0, height: 0)
        popover.permittedArrowDirections = []
    }

    func executeJSCallback(_ callbackFunc: String, result: [String: Any] = [:]) {
        // WKWebView is main-thread only, and plugins answer from wherever their
        // work finished — a URLSession completion handler, say. Calling it from
        // a background queue crashes the whole app, not just the page.
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.executeJSCallback(callbackFunc, result: result) }
            return
        }

        let script = "try { var cb = \(callbackFunc); if (cb) { cb(\(encodeJSON(result))); } } catch (e) { console.log(e); }"
        self.webView.evaluateJavaScript(script, completionHandler:nil)
    }
    
    func encodeJSON(_ object: [String: Any]) -> String {
        do {
            let jsonData = try JSONSerialization.data(withJSONObject: object, options: [])
            let jsonString = NSString(data: jsonData, encoding: String.Encoding.utf8.rawValue)!
            return jsonString as String
        }
        catch {
            log.error("Unable to encode JSON argument for callback: \(object)")
            return "null"
        }
    }

    // Create a unique number for each callback so we can shuttle callback
    // results back to the Swift side.
    var nextCallbackNum = 1
    var callbacks: [Int: (([String: Any]) -> Void)] = [:]
    
    // Call a function in JS with a result value and an optional completion
    // callback that can accept a [String: Any] result itself.
    func sendToWindowListener(_ handler: String, args: String = "undefined", callback: (([String: Any]) -> Void)? = nil) {
        // Main-thread only, for the same reason as executeJSCallback (and the
        // callbacks dictionary isn't safe to touch from two threads either).
        guard Thread.isMainThread else {
            DispatchQueue.main.async { self.sendToWindowListener(handler, args: args, callback: callback) }
            return
        }

        var js: String

        if let callback = callback {
            let callbackNum = self.nextCallbackNum
            self.nextCallbackNum += 1

            // Wrap in a closure that will call the callback and remove it from
            // the callbacks dictionary.
            callbacks[callbackNum] = { result in
                self.callbacks.removeValue(forKey: callbackNum)
                callback(result)
            }

            js = "window.\(handler) && window.\(handler)(\(args), \(callbackNum));"
        }
        else {
            js = "window.\(handler) && window.\(handler)(\(args));"
        }

        webView.evaluateJavaScript(js) { (result, error) in
            if error != nil {
                self.log.error("Error evaluating JS for handler \(handler).", error)
                return
            }
        }
    }

    func executeSwiftCallback(_ body: [String: Any]) {
        let callbackNum = body["callbackNum"] as! Int

        if let callback = callbacks[callbackNum] {
            callback(body)
        }
        else {
            log.error("Unable to find callback for \(callbackNum)")
        }
    }
    
    //
    // Crash Recovery
    //
    
    var webViewWasTerminated = false
    
    /// The icon badge the web layer last asked for.
    var lastAppIconBadge: Int?
    
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        for plugin in plugins {
            plugin.webContentProcessDidTerminate()
        }

        if UIApplication.shared.applicationState == .active {
            // Reload it now!
            log.info("Web view terminated! Reloading now.")
            reloadWebView()
        }
        else {
            // Reload it when we come back!
            log.info("Web view terminated in background! Reloading later.")
            webViewWasTerminated = true
        }
    }
    
    @objc func applicationDidBecomeActive() {
        log.info("Application became active with webView.url: \(String(describing: webView.url))")
        sendAppStateChange("active")
        
        // A push that arrived while we weren't in front set the icon's badge
        // to its own count, which may be for a message already read here. On
        // a Mac the web layer kept running the whole time and won't send the
        // same count again, so put back the last one it sent.
        if let badge = lastAppIconBadge {
            UNUserNotificationCenter.current().setBadgeCount(badge)
        }
        
        if webViewWasTerminated || webView.url == nil {
            reloadWebView()
            webViewWasTerminated = false
        }
    }
    
    @objc func applicationWillResignActive() {
        sendAppStateChange("inactive")
    }

    @objc func applicationDidEnterBackground() {
        sendAppStateChange("background")
    }

    /// Tells the web app when it leaves and returns to the foreground. iOS
    /// stops its timers while we're away, and it can't otherwise tell that
    /// apart from being too busy to run them. The page may be suspended before
    /// this runs, so `at` carries when it actually happened.
    func sendAppStateChange(_ state: String) {
        let at = Int(Date().timeIntervalSince1970 * 1000)
        sendToWindowListener("onAppStateChange", args: "{state: \"\(state)\", at: \(at)}")
    }

    func reloadWebView() {
        if let url = currentURL {
            log.info("Reloading terminated web view with URL: \(url)")
            reallyLoad(URLString: url.absoluteString)
        }
        else {
            log.info("Can't reload the web view because currentURL == nil.")
        }
    }
    
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log.error("Web view failed provisional navigation.", error)
    }
    
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        log.error("Web view failed navigation.", error)
    }
    
    //
    // JS Alerts
    //
    
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        
        let alert = UIAlertController(title: message, message: nil, preferredStyle: UIAlertController.Style.alert)
        
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel, handler: { action in
            completionHandler(false)
        }))
        
        alert.addAction(UIAlertAction(title: "Ok", style: .default, handler: { action in
            completionHandler(true)
        }))
        
        self.present(alert, animated: true, completion: nil)
    }
    
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: (@escaping () -> Void)) {
        
        let alert = UIAlertController(title: message, message: nil, preferredStyle: UIAlertController.Style.alert)
        
        alert.addAction(UIAlertAction(title: "Ok", style: .default, handler: { action in
            completionHandler()
        }))
        
        self.present(alert, animated: true, completion: nil)
    }
    
    //
    // Link clicking
    //
    
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        
        // Is this a 'new window action' (aka target="_blank")?
        let isTargetBlank = navigationAction.navigationType == WKNavigationType.linkActivated

        if isTargetBlank {
            let url = navigationAction.request.url
            
            if UIApplication.shared.canOpenURL(url!) {
                UIApplication.shared.open(url!)
            }
            
            decisionHandler(.cancel)
            return
        }
        
        decisionHandler(.allow)
    }
    
    //
    // Scroll-to-top
    //
    
    /// Empty, hidden scroll views, always scrolled down by a pixel, that trap
    /// the shouldScrollToTop delegate event when the status bar is tapped. The
    /// system hands the tap to the scroll view under it, and it doesn't tell
    /// us where the tap was any other way, so they stand side by side in thin
    /// columns: whichever one fires says where the tap landed, and the web app
    /// can scroll just what's under it (one pane of a split view, like
    /// Settings on iPad).
    private var scrollToTopTraps: [UIScrollView] = []
    private let scrollToTopTrapWidth: CGFloat = 20

    #if targetEnvironment(macCatalyst)
    // On a Mac the title bar (just the traffic lights; see SceneDelegate) is
    // ours to draw into, so cancel the safe area it claims and let the web's
    // header sit up in it. LayoutObserver reports the traffic lights instead,
    // as a corner for the header to clear.
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        let titlebar = view.safeAreaInsets.top - additionalSafeAreaInsets.top
        if additionalSafeAreaInsets.top != -titlebar {
            additionalSafeAreaInsets.top = -titlebar
        }
    }
    #endif

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutScrollToTopTraps()
    }

    private func layoutScrollToTopTraps() {
        let bounds = self.view.bounds
        let count = max(1, Int((bounds.width / scrollToTopTrapWidth).rounded(.up)))

        while scrollToTopTraps.count < count {
            let trap = UIScrollView()
            trap.contentSize.height = 9999
            trap.contentOffset.y = 1
            trap.delegate = self
            // Behind everything else.
            self.view.insertSubview(trap, at: 0)
            scrollToTopTraps.append(trap)
        }
        while scrollToTopTraps.count > count {
            scrollToTopTraps.removeLast().removeFromSuperview()
        }

        let width = bounds.width / CGFloat(count)
        for (i, trap) in scrollToTopTraps.enumerated() {
            trap.frame = CGRect(x: CGFloat(i) * width, y: 0, width: width, height: bounds.height)
        }
    }

    func scrollViewShouldScrollToTop(_ scrollView: UIScrollView) -> Bool {
        let x = scrollView.frame.midX
        log.debug("Should scroll to top at x=\(x)?")
        sendToWindowListener("onScrollToTop", args: "{x: \(x)}")
        return false
    }
    
    //
    // Keyboard Handling
    //
    
    var lastNotification:Notification?
    
    @objc func keyboardWillShow(_ notification:Notification) {
        log.debug("Keyboard will show!")
        
        lastNotification = notification
        cancelPendingKeyboardCalls()
        self.perform(#selector(keyboardWillReallyShow), with: nil, afterDelay: 0.01)
    }
    
    @objc func keyboardWillHide(_ notification:Notification) {
        log.debug("Keyboard will hide!")
        
        lastNotification = notification
        cancelPendingKeyboardCalls()
        self.perform(#selector(keyboardWillReallyHide), with: nil, afterDelay: 0.01)
    }
    
    func cancelPendingKeyboardCalls() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(keyboardWillReallyHide), object: nil)
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(keyboardWillReallyShow), object: nil)
    }
    
    @objc func keyboardWillReallyShow() {
        log.debug("Keyboard will really show!")
        
        let keyboardFrame = ((lastNotification! as NSNotification).userInfo![UIResponder.keyboardFrameEndUserInfoKey]! as AnyObject).cgRectValue
        // Keyboard frame is in window/screen coordinates; convert from our own
        // window. (Under the UIScene lifecycle the app delegate has no window.)
        let localFrame = self.view.convert(keyboardFrame!, from: self.view.window);

        // iOS still sends "will show" with a hardware keyboard attached (for
        // just the shortcuts bar, or a keyboard parked offscreen), and when
        // the scene changes size or display. Only count a keyboard that
        // actually covers a meaningful part of us.
        let overlap = self.view.bounds.intersection(localFrame).height
        guard overlap > 100 else {
            keyboardWillReallyHide()
            return
        }

        sendToWindowListener("onViewportChange", args: "{keyboardVisible: true, height:\(localFrame.origin.y / webView.pageZoom)}")
    }
    
    @objc func keyboardWillReallyHide() {
        log.debug("Keyboard will really hide!")

        sendToWindowListener("onViewportChange", args: "{}")
    }
    
    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Keep the web view's own scroll view still (the traps stay put).
        guard scrollView === webView?.scrollView else { return }
        scrollView.contentOffset = CGPoint.zero
    }
    
    func viewForZooming(in scrollView: UIScrollView) -> UIView? {
        return nil
    }
    
    //
    // Deep link handling
    //
    
    public func handleDeepLink(link: String) {
        
        if !featuresRequested {
            self.log.info("Features haven't been requested yet. Storing deep link for next getFeatures().")
            self.pendingDeepLink = link
            return
        }

        sendToWindowListener("onDeepLink", args: "\"\(link)\"")
    }
    
    //
    // Dynamic Type
    //

    @objc func contentSizeCategoryDidChange() {
        // The notification only fires on an actual change, so always forward the
        // new preferred body font size to the web app.
        let size = TextSizeAdjustment.preferredFontSize
        self.log.info("Content size category changed! Preferred body font size is now \(size)")

        sendToWindowListener("onPreferredFontSizeChange", args: "\(size)")
    }
    
    //
    // Compose Sheets
    //
    
    func messageComposeViewController(_ controller: MFMessageComposeViewController, didFinishWith result: MessageComposeResult) {
        controller.dismiss(animated: true, completion: nil)
    }
    
    func mailComposeController(_ controller: MFMailComposeViewController, didFinishWith result: MFMailComposeResult, error: Error?) {
        controller.dismiss(animated: true, completion: nil)
    }
    
    //
    // Delay Updates
    //

    // Set if we should not reload an active webview until this time.
    private var pauseReloadUntil: Date?
    private var reloadPending: Bool = false

    // Manual resume timer.
    private var resumeTimer: Timer?

    func delayUpdates(duration: Int) {
        // Convert duration which is in ms into a TimeInterval.
        let interval = TimeInterval(duration) / 1000.0
        self.pauseReloadUntil = Date().addingTimeInterval(interval)
        
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = TimeZone.current
        let untilStr = formatter.string(from: pauseReloadUntil!)
        
        log.info("Delaying updates for \(duration)ms (until \(untilStr)).")

        // Just in case something goes wrong and delayUpdates(0) is never
        // called, we'll set our own timer to resume updates.
        self.resumeTimer?.invalidate()
        self.resumeTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { _ in
            self.resumeUpdates()
        }
    }

    func resumeUpdates() {
        self.resumeTimer?.invalidate()
        self.pauseReloadUntil = nil
        log.info("Resuming updates.")

        if self.reloadPending {
            log.info("A reload was pending! Reloading now.")
            self.reloadPending = false
            self.reload()
        }
    }
    
    //
    // Microphone/Camera Access
    //

    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        // Allow all access.
        log.info("Deciding to grant access to media capture.")
        return .grant
    }
        
    //
    // Running against local HTTPS servers with our self-signed cert
    //
    
    func webView(_ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
                
        if currentURL?.host?.hasSuffix(".local") ?? false {
            log.info("Ignoring authentication challenge from *.local")
            completionHandler(.useCredential, URLCredential(trust: challenge.protectionSpace.serverTrust!))
        }
        else {
            log.info("Performing default handling for authentication challenge.")
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

#if canImport(FirebaseAuth)
// For Firebase Auth's own sign-in screens, in an app that has it. Its
// methods (present, dismiss) are UIViewController's.
extension WebAppViewController: AuthUIDelegate {}
#endif
