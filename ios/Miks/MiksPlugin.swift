import Foundation
import GameController
import UIKit

/// What the page can't do itself. `fullName` turns the name you type for a Mac
/// ("air") into its full one ("air.tailbf8edc.ts.net"), the only one its
/// gateway's certificate is for: Tailscale's DNS finds it by the short name (its
/// search domain), and gives the full one back for its address.
/// `hardwareKeyboard` says whether one's connected (and `miks_hardwareKeyboard`
/// whenever that changes), so the page knows focusing won't bring up the
/// on-screen keyboard. `page` is the pages in tabs' panels (Pages.swift).
/// `appInfo` is the app's version and the device's name, for `miks version`.
/// `pushToken` is this device's, from AppDelegate (and `miks_pushToken` once
/// it has one), with its APNs environment; `pendingNotification`, the one
/// tapped to launch the app, whose tab the page opens once it's up.
class MiksPlugin: WebAppPlugin {
    override var name: String { "miks" }

    override var features: [String: Any] { ["fullName": true, "hardwareKeyboard": true, "pages": true, "push": true] }

    static var pushToken: String?
    static var pendingNotification: [String: String]?

    /// Development builds (Xcode, ios/share.sh) carry their profile, which
    /// says the sandbox; TestFlight and App Store ones carry none.
    static let pushEnvironment: String = {
        guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
              let data = FileManager.default.contents(atPath: path),
              let text = String(data: data, encoding: .isoLatin1),
              text.range(of: "<key>aps-environment</key>\\s*<string>development</string>", options: .regularExpression) != nil
        else { return "production" }
        return "development"
    }()

    static var pushInfo: [String: Any] {
        guard let token = pushToken else { return [:] }
        return ["token": token, "environment": pushEnvironment]
    }

    static var pushInfoJSON: String { json(pushInfo) }

    static func takePendingNotificationJSON() -> String? {
        guard let pending = pendingNotification else { return nil }
        pendingNotification = nil
        return json(pending)
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }

    private lazy var pages = Pages(webApp: webApp) { [weak self] state in self?.sendToPluginListener("page", args: state) }

    override init(webApp: WebAppViewController) {
        super.init(webApp: webApp)
        for notification in [Notification.Name.GCKeyboardDidConnect, .GCKeyboardDidDisconnect] {
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: notification, object: nil)
        }
    }

    private var hasHardwareKeyboard: Bool { GCKeyboard.coalesced != nil }

    // The next page starts with no pages of its own.
    override func webContentProcessDidTerminate() {
        pages.handle(["action": "closeAll"])
    }

    @objc private func keyboardChanged() {
        sendToPluginListener("hardwareKeyboard", args: hasHardwareKeyboard ? "true" : "false")
    }

    override func handleMessage(name: String, body: [String: Any]) -> Bool {
        switch name {
        case "hardwareKeyboard":
            guard let callback = body["callback"] as? String else { return false }
            webApp.executeJSCallback(callback, result: ["connected": hasHardwareKeyboard])
            return true
        case "page":
            pages.handle(body)
            return true
        case "pushToken":
            guard let callback = body["callback"] as? String else { return false }
            webApp.executeJSCallback(callback, result: MiksPlugin.pushInfo)
            return true
        case "pendingNotification":
            guard let callback = body["callback"] as? String else { return false }
            let pending = MiksPlugin.pendingNotification ?? [:]
            MiksPlugin.pendingNotification = nil
            webApp.executeJSCallback(callback, result: pending)
            return true
        case "appInfo":
            guard let callback = body["callback"] as? String else { return false }
            let info = Bundle.main.infoDictionary ?? [:]
            webApp.executeJSCallback(callback, result: [
                "version": info["CFBundleShortVersionString"] as? String ?? "?",
                "build": info["CFBundleVersion"] as? String ?? "?",
                "device": UIDevice.current.name,
            ])
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
