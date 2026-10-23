import Network
import UIKit
import WebKit

/// A test, for now: a web view whose traffic all goes out from the Mac, through
/// its gateway's proxy (Gateway.ts, Proxy.ts), so `localhost` should be the
/// Mac's, as it is for `miks browse` in a Mac's window. What's in question is
/// whether WebKit sends `localhost` through a proxy at all.
class TestBrowserController: UIViewController, UITextFieldDelegate, WKNavigationDelegate {
    private let mac: String
    private let initialURL: String
    private var webView: WKWebView!
    private let address = UITextField()
    private let status = UILabel()

    init(mac: String, url: String) {
        self.mac = mac
        self.initialURL = url
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        let store = WKWebsiteDataStore.nonPersistent()
        let proxy = ProxyConfiguration(
            httpCONNECTProxy: .hostPort(host: NWEndpoint.Host(mac), port: 2741),
            tlsOptions: NWProtocolTLS.Options()
        )
        store.proxyConfigurations = [proxy]
        let config = WKWebViewConfiguration()
        config.websiteDataStore = store
        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.isInspectable = true

        address.text = initialURL
        address.borderStyle = .roundedRect
        address.autocapitalizationType = .none
        address.autocorrectionType = .no
        address.keyboardType = .URL
        address.returnKeyType = .go
        address.delegate = self

        let done = UIButton(type: .system, primaryAction: UIAction(title: "Done") { [weak self] _ in self?.dismiss(animated: true) })
        status.font = .preferredFont(forTextStyle: .footnote)
        status.textColor = .secondaryLabel
        status.numberOfLines = 2
        status.text = "Through \(mac):2741"

        let bar = UIStackView(arrangedSubviews: [address, done])
        bar.spacing = 12
        for subview in [bar, status, webView!] {
            subview.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(subview)
        }
        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: guide.topAnchor, constant: 12),
            bar.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 16),
            bar.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -16),
            status.topAnchor.constraint(equalTo: bar.bottomAnchor, constant: 6),
            status.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
            status.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
            webView.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 8),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        load(initialURL)
    }

    private func load(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard let url = URL(string: trimmed.contains("://") ? trimmed : "http://\(trimmed)") else { return }
        status.text = "Loading \(url.absoluteString) through \(mac):2741…"
        webView.load(URLRequest(url: url))
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        load(textField.text ?? "")
        textField.resignFirstResponder()
        return true
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        status.text = "Loaded \(webView.url?.absoluteString ?? "") through \(mac):2741"
        address.text = webView.url?.absoluteString
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        status.text = "Failed: \(error.localizedDescription)"
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        status.text = "Failed: \(error.localizedDescription)"
    }
}
