import CryptoKit
import Network
import UIKit
import WebKit

/// The pages `miks browse` puts in tabs' panels, which in the app are web views
/// of its own, over the app's at the place the page leaves for each (ui/nativePage.ts).
/// Each loads through the Mac's gateway (Gateway.ts, Proxy.ts), so a page is
/// what it would be in a window on that Mac. WebKit never sends `localhost` to
/// a proxy, so pages load it as `mac.localhost` (which the Mac resolves to
/// itself, and Vite allows), and the page hears of it as `localhost`.
class Pages {
    private let webApp: WebAppViewController
    private let send: (String) -> Void
    private var pages: [String: Page] = [:]

    init(webApp: WebAppViewController, send: @escaping (String) -> Void) {
        self.webApp = webApp
        self.send = send
    }

    func handle(_ body: [String: Any]) {
        if body["action"] as? String == "closeAll" {
            for page in pages.values { page.close() }
            pages = [:]
            return
        }
        guard let id = body["id"] as? String else { return }
        switch body["action"] as? String {
        case "open":
            guard let url = body["url"] as? String, let mac = body["mac"] as? String else { return }
            if pages[id] == nil {
                let page = Page(id: id, mac: mac, port: body["port"] as? Int ?? 2741) { [weak self] state in
                    self?.send(state)
                }
                webApp.view.addSubview(page)
                pages[id] = page
            }
            pages[id]?.load(url)
        case "frame":
            guard let page = pages[id] else { return }
            if let rect = body["rect"] as? [String: Double], let clip = body["clip"] as? [String: Double], body["visible"] as? Bool == true {
                page.place(rect: points(rect), clip: points(clip))
            } else {
                page.isHidden = true
            }
        case "back": pages[id]?.webView.goBack()
        case "forward": pages[id]?.webView.goForward()
        case "reload": pages[id]?.webView.reload()
        case "stop": pages[id]?.webView.stopLoading()
        case "focus": pages[id]?.webView.becomeFirstResponder()
        case "close":
            pages.removeValue(forKey: id)?.close()
        default:
            break
        }
    }

    /// A rect in the app's CSS pixels, in the controller's view.
    private func points(_ rect: [String: Double]) -> CGRect {
        let zoom = webApp.pageZoom
        let css = CGRect(x: rect["x"] ?? 0, y: rect["y"] ?? 0, width: rect["width"] ?? 0, height: rect["height"] ?? 0)
        let scaled = CGRect(x: css.minX * zoom, y: css.minY * zoom, width: css.width * zoom, height: css.height * zoom)
        guard let appView = webApp.view.subviews.first(where: { $0 is WKWebView }) else { return scaled }
        return appView.convert(scaled, to: webApp.view)
    }
}

/// One page: its web view, in a view clipped as the panel clips it (a panel
/// sliding in), so the page itself keeps its size.
private class Page: UIView, WKNavigationDelegate, WKUIDelegate {
    let id: String
    let webView: WKWebView
    private let onState: (String) -> Void
    private var observers: [NSKeyValueObservation] = []

    init(id: String, mac: String, port: Int, onState: @escaping (String) -> Void) {
        self.id = id
        self.onState = onState

        // Each Mac's pages have their own cookies and storage, as each daemon's
        // window has its own session on a Mac.
        let store = WKWebsiteDataStore(forIdentifier: Page.storeID(mac))
        store.proxyConfigurations = [
            ProxyConfiguration(
                httpCONNECTProxy: .hostPort(host: NWEndpoint.Host(mac), port: NWEndpoint.Port(rawValue: UInt16(port))!),
                tlsOptions: NWProtocolTLS.Options()
            ),
        ]
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        config.allowsInlineMediaPlayback = true
        webView = WKWebView(frame: .zero, configuration: config)
        webView.isInspectable = true
        webView.allowsBackForwardNavigationGestures = true

        super.init(frame: .zero)
        clipsToBounds = true
        isHidden = true
        addSubview(webView)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        observers = [
            webView.observe(\.url, changeHandler: { [weak self] _, _ in self?.report() }),
            webView.observe(\.title, changeHandler: { [weak self] _, _ in self?.report() }),
            webView.observe(\.isLoading, changeHandler: { [weak self] _, _ in self?.report() }),
            webView.observe(\.canGoBack, changeHandler: { [weak self] _, _ in self?.report() }),
            webView.observe(\.canGoForward, changeHandler: { [weak self] _, _ in self?.report() }),
        ]
    }

    required init?(coder: NSCoder) { fatalError() }

    private static func storeID(_ mac: String) -> UUID {
        let bytes = Array(SHA256.hash(data: Data(mac.utf8)).prefix(16))
        return UUID(uuid: (bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
                           bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]))
    }

    func load(_ url: String) {
        guard let url = URL(string: url) else { return }
        webView.load(URLRequest(url: Page.toMac(url)))
    }

    func place(rect: CGRect, clip: CGRect) {
        frame = clip
        webView.frame = rect.offsetBy(dx: -clip.minX, dy: -clip.minY)
        isHidden = clip.isEmpty
    }

    func close() {
        observers = []
        webView.stopLoading()
        removeFromSuperview()
    }

    private func report(failed: String? = nil) {
        var state: [String: Any] = [
            "id": id,
            "url": webView.url.map { Page.fromMac($0).absoluteString } ?? "",
            "title": webView.title ?? "",
            "loading": webView.isLoading,
            "back": webView.canGoBack,
            "forward": webView.canGoForward,
        ]
        if let failed { state["failed"] = failed }
        guard let data = try? JSONSerialization.data(withJSONObject: state), let json = String(data: data, encoding: .utf8) else { return }
        onState(json)
    }

    private static let loopback: Set<String> = ["localhost", "127.0.0.1", "::1"]

    static func toMac(_ url: URL) -> URL {
        guard let host = url.host(), loopback.contains(host), var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.host = "mac.localhost"
        return parts.url ?? url
    }

    static func fromMac(_ url: URL) -> URL {
        guard url.host() == "mac.localhost", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        parts.host = "localhost"
        return parts.url ?? url
    }

    // A link straight to localhost would go to the device's own.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.targetFrame?.isMainFrame == true, Page.toMac(url) != url {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: Page.toMac(url)))
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        // A load given up for another (a click before it finished).
        if (error as NSError).code == NSURLErrorCancelled { return }
        report(failed: error.localizedDescription)
    }

    // A page's new windows open in Safari, as they open in a browser on a Mac.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(Page.fromMac(url)) }
        return nil
    }
}
