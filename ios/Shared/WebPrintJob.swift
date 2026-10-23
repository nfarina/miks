// @chatwing
import UIKit
@preconcurrency import WebKit

/// Prints a web page natively: loads `url` offscreen, waits for it to finish
/// rendering, then hands it to the system print sheet (AirPrint) — printer
/// picker, preview, copies, all without ever leaving the app.
///
/// This exists because a WKWebView has no print of its own. The web app's only
/// other option is to bounce the user out to Safari and let them find Print in
/// the share menu, which is several taps and a context switch for something
/// that should be one tap.
///
/// Two things are worth knowing about the approach:
///
/// - `UIMarkupTextPrintFormatter` looks like the obvious way to print HTML, but
///   it renders with an ancient engine — no grid, no flexbox, no `@page`. Any
///   real print stylesheet falls apart in it. `viewPrintFormatter()` on a
///   WKWebView renders with the same WebKit as the rest of the app.
/// - The page is a single-page app, so `didFinish` only means the HTML arrived,
///   not that anything is on screen yet. We poll for the `data-print-ready`
///   marker the print layouts render once they have their content.
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
    private weak var presenter: UIViewController?
    private var completion: ((String?) -> Void)?

    private var webView: WKWebView?
    private var retained: WebPrintJob?
    private var finished = false
    private var deadline = Date.distantFuture

    init(url: URL, jobName: String, presenter: UIViewController, completion: @escaping (String?) -> Void) {
        self.url = url
        self.jobName = jobName
        self.presenter = presenter
        self.completion = completion
    }

    func start() {
        guard let presenter = presenter, let container = presenter.viewIfLoaded else {
            finish(error: "Nothing to print from.")
            return
        }

        // Letter-ish proportions at a comfortable reading width. A zero-sized
        // web view lays out at zero width and prints blank pages, and one that
        // isn't in the hierarchy at all may never render, so this lives in the
        // view — parked far offscreen and inert.
        let webView = WKWebView(frame: CGRect(x: -10000, y: 0, width: 820, height: 1060))
        webView.isUserInteractionEnabled = false
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

    /// The document has loaded, but the app inside it still has to render (and,
    /// for a recipe, decode its photo). The print layouts mark themselves ready
    /// when they're done; poll until that appears.
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
        guard !finished, let webView = webView, let presenter = presenter, let view = presenter.viewIfLoaded else {
            finish(error: "Nothing to print from.")
            return
        }

        let printInfo = UIPrintInfo.printInfo()
        printInfo.outputType = .general
        printInfo.jobName = jobName

        let controller = UIPrintInteractionController.shared
        controller.printInfo = printInfo
        controller.printFormatter = webView.viewPrintFormatter()

        // The sheet is up (or failed to come up); either way the web app can
        // stop showing a working state. The job itself outlives this callback,
        // which is why the web view stays alive until the sheet is dismissed.
        let presented: UIPrintInteractionController.CompletionHandler = { [weak self] _, _, error in
            self?.teardown()
            if let error = error {
                log.error("Printing failed: \(error.localizedDescription)")
            }
        }

        if UIDevice.current.userInterfaceIdiom == .pad {
            // Required on iPad, which presents this in a popover.
            let rect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 0, height: 0)
            controller.present(from: rect, in: view, animated: true, completionHandler: presented)
        } else {
            controller.present(animated: true, completionHandler: presented)
        }

        // Report success as soon as the sheet is on its way up, rather than
        // waiting for the user to finish with it.
        report(error: nil)
    }

    private func finish(error: String?) {
        report(error: error)
        teardown()
    }

    /// Calls back exactly once; later calls (a timeout that fires after the
    /// sheet is already up, say) are ignored.
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
