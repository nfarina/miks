// @chatwing
import AppKit
@preconcurrency import WebKit
import StoreKit
import UserNotifications

protocol WebAppViewControllerDelegate {
    func webAppViewController(_ controller: WebAppViewController, didLoginWithToken token:String)
    func webAppViewControllerDidLogout(_ controller: WebAppViewController)
    func webAppViewControllerDidRequestNotificationAuthorization(_ controller: WebAppViewController)
    func webAppViewControllerDidRequestMicrophoneAuthorization(_ controller: WebAppViewController)
}

/// The Mac app's side of the bridge to the web app: the same messages as the
/// iOS shell's WebAppViewController (ios/Shared), answered with AppKit.
///
/// This replaced a Mac Catalyst build of the iOS shell. There, WKWebView takes
/// typing the iOS way: every key goes through UIKit, which asks WebKit for the
/// text around the caret, synchronously, while WebKit waits on UIKit. Typing
/// lagged and the caret jumped until autocorrect was switched off. An AppKit
/// WKWebView takes typing like Safari does, through the Mac's text system, so
/// autocorrect, text replacement and Writing Tools all just work.
///
/// The web app can't tell the difference: it hears `platform: "macOS"` from
/// either shell.
class WebAppViewController:
    NSViewController,
    WKScriptMessageHandler,
    WKUIDelegate,
    WKNavigationDelegate
{

    private let log = Logger(prefix: "webapp")

    var delegate:WebAppViewControllerDelegate?

    private var currentURL: URL?
    private var pendingDeepLink: String?

    private var webView: WKWebView!

    /// Points per CSS pixel, for plugins trading lengths with the web.
    var pageZoom: CGFloat { webView.pageZoom }
    private let layoutObserver = LayoutObserver()
    private var loadingView: NSProgressIndicator!
    private var loadProgress: Float? = nil
    private var featuresRequested: Bool = false

    // Array of loaded plugins.
    private var plugins: [WebAppPlugin] = []

    override func loadView() {
        self.view = NSView(frame: NSRect(x: 0, y: 0, width: 1100, height: 760))

        // WebKit keeps its text checking settings in the app's own defaults,
        // like Safari's, and spelling-as-you-type starts off until an app turns
        // it on. Autocorrection only runs alongside it, so without this nothing
        // gets corrected. Registered rather than set, so the Edit menu's
        // toggles still stick. Read once per app launch, before the first web
        // view.
        UserDefaults.standard.register(defaults: ["WebContinuousSpellCheckingEnabled": true])

        // Build the web view.
        let userController = WKUserContentController()
        userController.add(self, name: "default")
        let webConfig = WKWebViewConfiguration()
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

        // The model speaks the moment it connects, so a first reply that
        // waited on a click would be silent.
        webConfig.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: webConfig)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        // Until the page paints, show the window's own background (which
        // follows dark mode) rather than a white flash.
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsMagnification = false
        webView.isInspectable = true

        // The page lays out 1 CSS px as 1pt, the same as Safari, which leaves
        // the whole UI a little big beside native apps: a nav button lands at
        // 41.5pt next to Finder's 37pt. This is that ratio.
        webView.pageZoom = 0.89

        view.addSubview(webView)

        // Reports layout signals (size, the traffic lights' corner) to the
        // web app as they change.
        layoutObserver.pointsPerCSSPixel = webView.pageZoom
        layoutObserver.observe(webView)
        layoutObserver.onChange = { [weak self] layout in
            guard let self, self.featuresRequested else { return }
            self.sendToWindowListener("onLayoutChange", args: self.encodeJSON(layout))
        }

        // Carries the first launch, when there's no cached bundle to show
        // while one downloads.
        loadingView = NSProgressIndicator()
        loadingView.style = .bar
        loadingView.isIndeterminate = false
        loadingView.minValue = 0
        loadingView.maxValue = 1
        loadingView.frame = NSRect(x: (view.bounds.width - 200) / 2, y: (view.bounds.height - 20) / 2, width: 200, height: 20)
        loadingView.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
        loadingView.isHidden = true
        view.addSubview(loadingView)
        setLoadProgress(loadProgress)

        // Lets clicks reach the web's buttons up in the window's title bar.
        plugins.append(TitlebarPlugin(webApp: self))
        // The menu bar and its keyboard shortcuts.
        plugins.append(MenuPlugin(webApp: self))

        // Which plugins an app loads is the one genuinely per-app part of this
        // file — everything else here is shared, and where projects differ it
        // is because one is behind rather than because it wants to be.
        // @chatwing:plugins:start
        // @chatwing:plugins:end

        NotificationCenter.default.addObserver(self, selector: #selector(applicationDidBecomeActive), name: NSApplication.didBecomeActiveNotification, object: nil)
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        // Plugins that work with the window (the title bar) can't until now.
        for plugin in plugins {
            (plugin as? WindowAttachingPlugin)?.attach(to: view.window!)
        }
        layoutObserver.attach(to: view.window!)
    }

    //
    // Public Methods
    //

    func load(URLString: String) {
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

    func setLoadProgress(_ progress: Float?) {
        self.loadProgress = progress

        // If our view isn't loaded then we can't apply this progress right now; it'll happen in loadView().
        guard let loadingView = self.loadingView else { return }

        if let progress = progress {
            loadingView.isHidden = false
            loadingView.doubleValue = Double(progress)
        }
        else {
            loadingView.isHidden = true
        }
    }

    func isLoaded() -> Bool {
        return currentURL != nil
    }

    /// Shows the cached bundle on the page we're on, for when it arrives or
    /// the app switches servers. If it's already showing, `reload` decides
    /// whether to load it again (a newer one arrived) or leave it be.
    func showBundle(_ bundle: WebBundle, reload: Bool) {
        // Switched to a live server while this one was downloading.
        guard usingCachedWebBundle else { return }

        if let url = currentURL, url.isFileURL || url.scheme == WebBundleScheme {
            if reload { self.reload() }
            return
        }

        let page = currentURL.map { $0.path + ($0.query.map { "?\($0)" } ?? "") }
        load(URLString: bundle.applicationFileURL)
        if let page, !page.isEmpty, page != "/" { handleDeepLink(link: page) }
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

    /// Prints a page of the web app. See WebPrintJob for why this renders the
    /// page a second time, offscreen, rather than printing the one on screen.
    func printUrl(_ urlString: String, jobName: String, callback: String?) {
        log.info("Printing url: \"\(urlString)\"")

        guard let url = URL(string: urlString), let window = view.window else {
            log.error("Could not print url: \"\(urlString)\"")
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

        WebPrintJob(url: components?.url ?? url, jobName: jobName, window: window) { error in
            guard let callback = callback else { return }
            if let error = error {
                self.executeJSCallback(callback, result: ["error": error])
            } else {
                self.executeJSCallback(callback)
            }
        }.start()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {

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

            // Nothing in a Mac window has the keyboard until it's clicked, so
            // the page's own keys would do nothing at launch (or after a
            // reload, which starts the web view over).
            if view.window?.attachedSheet == nil {
                view.window?.makeFirstResponder(webView)
            }

            var result = [
                "identifier": DeviceIdentifier(),
                "clientUrl": clientUrl,
                "webBundle": usingCachedWebBundle,
                "login": true,
                "notifications": true,
                "notificationAuthorization": true,
                "safeArea": true,
                "clipboard": true,
                "clipboardRead": true,
                "shareSheet": true,
                "fileShare": true,
                "print": true,
                "messageSheet": false,
                "emailSheet": false,
                "preferredFontSize": TextSizeAdjustment.preferredFontSize,
                "wakeLock": true,
                "brightness": false,
                "reviewPrompt": true,
                // Drawn 1 CSS px as 1pt (page-zoomed to 0.89, as above), with
                // a 13pt body font rather than iOS's 17.
                "platform": "macOS",
                ] as [String : Any]

            if let layout = layoutObserver.layout {
                result["layout"] = layout
            }

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
            NSWorkspace.shared.open(URL(string: url)!)

        case "login":
            if let token = body["token"] as? String {
                delegate?.webAppViewController(self, didLoginWithToken: token)
            }

        case "logout":
            delegate?.webAppViewControllerDidLogout(self)

        case "onStatusBarStyleChange":
            // No status bar on a Mac.
            break

        case "setWakeLock":
            setWakeLock(body["on"] as! Bool)

        case "requestNotificationAuthorization":
            delegate?.webAppViewControllerDidRequestNotificationAuthorization(self)

        case "requestMicrophoneAuthorization":
            delegate?.webAppViewControllerDidRequestMicrophoneAuthorization(self)

        case "openSettings":
            // The web app sends people here to turn notifications back on,
            // which on a Mac is our page in System Settings → Notifications.
            let id = Bundle.main.bundleIdentifier ?? ""
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)")!)

        case "requestReview":
            // Best-effort native star-rating dialog. Apple rate-limits it
            // (~3×/year) and decides whether to actually show it, so the web
            // side always offers a write-review link as a guaranteed fallback.
            log.info("Requesting App Store review")
            AppStore.requestReview(in: self)

        case "badgeAppIcon":
            let badge = body["badge"] as! Int
            log.debug("Setting application icon badge to \(badge)")
            UNUserNotificationCenter.current().setBadgeCount(badge)
            lastAppIconBadge = badge

        case "clearReadNotifications":
            let unreadThreads = body["unreadThreads"] as! [String]
            AppNotifications.clearRead(unreadThreads: Set(unreadThreads))

        case "copyToClipboard":
            let text = body["text"] as! String
            log.info("Copying to clipboard: \"\(text)\"")
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)

        case "readClipboard":
            let callback = body["callback"] as! String
            let text = NSPasteboard.general.string(forType: .string) ?? ""
            log.info("Reading from clipboard (\(text.count) chars)")
            self.executeJSCallback(callback, result: ["text": text])

        case "showShareSheet":
            let text = body["text"] as! String
            log.info("Showing share sheet for text: \"\(text)\"")
            // A link shared as a String arrives in Messages as plain text: no
            // preview, and nothing the receiving app will turn into a link.
            var item: Any = text
            if let url = URL(string: text), url.scheme == "https" || url.scheme == "http" {
                item = url
            }
            NSSharingServicePicker(items: [item]).show(relativeTo: pointerRect(), of: view, preferredEdge: .minY)

        case "shareFile":
            let base64 = body["data"] as! String
            let fileName = body["fileName"] as! String
            // Optional callback so the webapp can show a working state until
            // the panel is actually on screen.
            let callback = body["callback"] as? String
            saveFile(base64: base64, fileName: fileName, callback: callback)

        case "printUrl":
            // Optional callback so the webapp can show a working state until
            // the print panel is actually on screen — loading and rendering
            // the page first takes a moment.
            printUrl(
                body["url"] as! String,
                jobName: body["jobName"] as? String ?? "Document",
                callback: body["callback"] as? String
            )

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

    /// Where to point a popover for something the web app asked for. The IPC
    /// doesn't say which button was clicked, but it was clicked a moment ago,
    /// so the pointer is on it.
    private func pointerRect() -> NSRect {
        guard let window = view.window else {
            return NSRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        let point = view.convert(window.mouseLocationOutsideOfEventStream, from: nil)
        return NSRect(x: point.x, y: point.y, width: 1, height: 1)
    }

    /// A file from the web app. iOS offers these in a share sheet, whose
    /// "Save to Files" is what people mostly want from it; on a Mac that's the
    /// save panel.
    private func saveFile(base64: String, fileName: String, callback: String?) {
        log.info("Saving file: \"\(fileName)\"")

        guard let data = Data(base64Encoded: base64), let window = view.window else {
            log.error("Could not decode base64 data for file: \"\(fileName)\"")
            if let callback = callback {
                executeJSCallback(callback, result: ["error": "Could not decode file data."])
            }
            return
        }

        let panel = NSSavePanel()
        panel.nameFieldStringValue = fileName
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let url = panel.url else { return }
            do {
                try data.write(to: url)
            } catch {
                self.log.error("Failed to save file: \(error.localizedDescription)")
                NSAlert(error: error).beginSheetModal(for: window)
            }
        }

        // The panel is up; let the webapp clear its spinner.
        if let callback = callback {
            executeJSCallback(callback)
        }
    }

    func executeJSCallback(_ callbackFunc: String, result: [String: Any] = [:]) {
        // WKWebView is main-thread only, and plugins answer from wherever their
        // work finished — a URLSession completion handler, say.
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
    // Wake lock
    //

    /// Held while the web app wants the display kept on.
    private var wakeLockActivity: NSObjectProtocol?

    private func setWakeLock(_ on: Bool) {
        log.info("Setting wake lock to \(on)")
        if on, wakeLockActivity == nil {
            wakeLockActivity = ProcessInfo.processInfo.beginActivity(
                options: [.idleDisplaySleepDisabled, .userInitiated],
                reason: "The web app asked to keep the display on."
            )
        } else if !on, let activity = wakeLockActivity {
            ProcessInfo.processInfo.endActivity(activity)
            wakeLockActivity = nil
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

        if NSApp.isActive {
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

        // A push that arrived while we weren't in front set the icon's badge
        // to its own count, which may be for a message already read here. The
        // web layer kept running the whole time and won't send the same count
        // again, so put back the last one it sent.
        if let badge = lastAppIconBadge {
            UNUserNotificationCenter.current().setBadgeCount(badge)
        }

        if webViewWasTerminated {
            reloadWebView()
            webViewWasTerminated = false
        }
    }

    func reloadWebView() {
        if let url = currentURL {
            log.info("Reloading terminated web view with URL: \(url)")
            load(URLString: url.absoluteString)
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
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: view.window!) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: (@escaping () -> Void)) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: view.window!) { _ in
            completionHandler()
        }
    }

    //
    // File uploads
    //

    // Unlike iOS, a Mac web view has no file picker of its own: without this,
    // clicking an <input type="file"> does nothing at all.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        panel.beginSheetModal(for: view.window!) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    //
    // Link clicking
    //

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {

        // A clicked link leaves the app; the web app navigates itself without
        // any.
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.allow)
    }

    // window.open(), which would otherwise do nothing.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
        }
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

/// A plugin that needs the window itself, which doesn't exist until the
/// controller's view is shown in one.
protocol WindowAttachingPlugin {
    func attach(to window: NSWindow)
}
