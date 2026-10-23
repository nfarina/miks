// @chatwing
import AppKit
@preconcurrency import WebKit

/// Prints a web page natively: loads `url` offscreen, waits for it to finish
/// rendering, then runs the print panel for it as a sheet on `window`.
///
/// The page is printed from a second web view rather than the one on screen,
/// which is showing the app around it. And it's a single-page app, so
/// `didFinish` only means the HTML arrived, not that anything is on screen
/// yet. We poll for the `data-print-ready` marker the print layouts render
/// once they have their content.
///
/// An instance keeps itself alive until the job finishes; callers can start one
/// and forget it.
class WebPrintJob: NSObject, WKNavigationDelegate {
    /// How long to wait for the page to load and signal readiness.
    private static let timeout: TimeInterval = 25

    /// How often to check for the readiness marker after the page loads.
    private static let pollInterval: TimeInterval = 0.15

    private let url: URL
    private let jobName: String
    private weak var window: NSWindow?
    private var completion: ((String?) -> Void)?

    private var webView: WKWebView?
    private var retained: WebPrintJob?
    private var finished = false
    private var deadline = Date.distantFuture

    init(url: URL, jobName: String, window: NSWindow, completion: @escaping (String?) -> Void) {
        self.url = url
        self.jobName = jobName
        self.window = window
        self.completion = completion
    }

    func start() {
        guard let container = window?.contentView else {
            finish(error: "Nothing to print from.")
            return
        }

        // Letter-ish proportions at a comfortable reading width. A web view
        // that isn't in a window never renders, so this one is, parked far
        // offscreen.
        let webView = WKWebView(frame: CGRect(x: -10000, y: 0, width: 820, height: 1060))
        webView.navigationDelegate = self
        container.addSubview(webView)
        self.webView = webView

        // Nothing else holds this object, so hold ourselves for the duration.
        retained = self

        deadline = Date().addingTimeInterval(Self.timeout)
        webView.load(URLRequest(url: url))

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.timeout) { [weak self] in
            guard let self = self, !self.finished else { return }
            log.error("Print page never finished loading; giving up.")
            self.finish(error: "Timed out preparing the page to print.")
        }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        log.info("Print page loaded; waiting for it to render.")
        waitForReady()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(error: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(error: error.localizedDescription)
    }

    // MARK: - Private

    private func waitForReady() {
        guard !finished, let webView = webView else { return }

        let script = "!!document.querySelector('[data-print-ready=\"true\"]')"

        webView.evaluateJavaScript(script) { [weak self] result, error in
            guard let self = self, !self.finished else { return }

            if let error = error {
                log.error("Print readiness check failed: \(error.localizedDescription)")
            }

            if (result as? Bool) == true {
                self.present()
            } else if Date() >= self.deadline {
                // Print what's there rather than nothing: a page that never
                // marks itself ready is more likely a layout we haven't taught
                // about the marker than a page with no content.
                log.info("Print page never signaled ready; printing it anyway.")
                self.present()
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.pollInterval) {
                    self.waitForReady()
                }
            }
        }
    }

    private func present() {
        guard !finished, let webView = webView, let window = window else {
            finish(error: "Nothing to print from.")
            return
        }

        let printInfo = NSPrintInfo.shared.copy() as! NSPrintInfo
        printInfo.horizontalPagination = .fit
        printInfo.verticalPagination = .automatic

        let operation = webView.printOperation(with: printInfo)
        operation.jobTitle = jobName
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        // Without a frame, WebKit's print view lays out at zero size and the
        // operation fails before the panel appears.
        operation.view?.frame = webView.bounds

        operation.runModal(
            for: window,
            delegate: self,
            didRun: #selector(printOperationDidRun(_:success:contextInfo:)),
            contextInfo: nil
        )

        // Report success as soon as the panel is on its way up, rather than
        // waiting for the user to finish with it.
        report(error: nil)
    }

    @objc private func printOperationDidRun(_ operation: NSPrintOperation, success: Bool, contextInfo: UnsafeMutableRawPointer?) {
        teardown()
    }

    private func finish(error: String?) {
        report(error: error)
        teardown()
    }

    /// Calls back exactly once; later calls (a timeout that fires after the
    /// panel is already up, say) are ignored.
    private func report(error: String?) {
        guard !finished else { return }
        finished = true
        completion?(error)
        completion = nil
    }

    private func teardown() {
        webView?.removeFromSuperview()
        webView = nil
        retained = nil
    }
}
