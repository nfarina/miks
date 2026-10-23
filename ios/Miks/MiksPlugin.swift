import Foundation
import GameController

/// What the page can't do itself. `fullName` turns the name you type for a Mac
/// ("air") into its full one ("air.tailbf8edc.ts.net"), the only one its
/// gateway's certificate is for: Tailscale's DNS finds it by the short name (its
/// search domain), and gives the full one back for its address.
/// `hardwareKeyboard` says whether one's connected (and `miks_hardwareKeyboard`
/// whenever that changes), so the page knows focusing won't bring up the
/// on-screen keyboard.
class MiksPlugin: WebAppPlugin {
    override var name: String { "miks" }

    override var features: [String: Any] { ["fullName": true, "hardwareKeyboard": true] }

    override init(webApp: WebAppViewController) {
        super.init(webApp: webApp)
        for notification in [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: notification, object: nil)
        }
    }

    private var hasHardwareKeyboard: Bool { GCKeyboard.coalesced != nil }

    @objc private func keyboardChanged() {
        sendToPluginListener("hardwareKeyboard", args: hasHardwareKeyboard ? "true" : "false")
    }

    override func handleMessage(name: String, body: [String: Any]) -> Bool {
        switch name {
        case "hardwareKeyboard":
            guard let callback = body["callback"] as? String else { return false }
            webApp.executeJSCallback(callback, result: ["connected": hasHardwareKeyboard])
            return true
        case "testBrowser":
            guard let mac = body["mac"] as? String, let url = body["url"] as? String else { return false }
            let browser = TestBrowserController(mac: mac, url: url)
            browser.modalPresentationStyle = .fullScreen
            webApp.present(browser, animated: true)
            return true
        case "fullName":
            guard let callback = body["callback"] as? String, let host = body["host"] as? String else { return false }
            DispatchQueue.global(qos: .userInitiated).async {
                let full = MiksPlugin.fullName(host)
                self.webApp.executeJSCallback(callback, result: full.map { ["name": $0] } ?? [:])
            }
            return true
        default:
            return false
        }
    }

    /// The name the address `host` resolves to has, by reverse lookup.
    static func fullName(_ host: String) -> String? {
        var hints = addrinfo()
        hints.ai_socktype = SOCK_STREAM
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0 else { return nil }
        defer { freeaddrinfo(result) }

        var entry = result
        while let info = entry?.pointee {
            var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(info.ai_addr, info.ai_addrlen, &name, socklen_t(name.count), nil, 0, NI_NAMEREQD) == 0 {
                let full = String(cString: name).trimmingCharacters(in: CharacterSet(charactersIn: "."))
                if full.contains(".") { return full }
            }
            entry = info.ai_next
        }
        return nil
    }
}
