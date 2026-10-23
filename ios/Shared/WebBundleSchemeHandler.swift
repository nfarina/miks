// @chatwing
import Foundation
import WebKit

/// Serves the cached web bundle over a custom scheme instead of `file://`.
///
/// `file://` pages have a null, opaque origin, and a surprising amount of the
/// platform quietly refuses to work there: an AudioWorklet can't load even the
/// blob its own page just created ("cross-origin script load denied"), ES
/// modules are refused, and anything origin-scoped — storage, crypto.subtle —
/// is either unavailable or shared with every other file:// page. Each one
/// fails in a way that reads like an application bug rather than an origin
/// problem, which is what makes it expensive.
///
/// A custom scheme is a *real* origin. `crosswing://app/` behaves like any
/// https site to the page: worklets load, modules load, storage is scoped to
/// this app alone. It needs no local HTTP server and no private API, so unlike
/// `allowUniversalAccessFromFileURLs` — which disables origin checks wholesale
/// — it's something an App Store build can ship.
public let WebBundleScheme = "crosswing"

/// Where the page thinks it is: `crosswing://app/`.
public let WebBundleSchemeHost = "app"

public class WebBundleSchemeHandler: NSObject, WKURLSchemeHandler {
    private let log = Logger(prefix: "schemehandler")

    /// Directory the bundle was unpacked into. Resolved per request so a
    /// freshly downloaded bundle is picked up without rebuilding the handler.
    private let rootDirectory: () -> String

    public init(rootDirectory: @escaping () -> String) {
        self.rootDirectory = rootDirectory
        super.init()
    }

    public func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(error(.badURL, "No URL"))
            return
        }

        guard let path = resolve(url: url) else {
            log.warn("Refusing \(url.path)")
            urlSchemeTask.didFailWithError(error(.noPermissionsToReadFile, "Forbidden"))
            return
        }

        guard let data = FileManager.default.contents(atPath: path) else {
            log.warn("Not found: \(path)")
            urlSchemeTask.didFailWithError(error(.fileDoesNotExist, "Not found"))
            return
        }

        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": mimeType(forPath: path),
                "Content-Length": String(data.count),
                // Same-origin by construction, but the page fetches its own
                // assets as modules, which are CORS-checked regardless.
                "Access-Control-Allow-Origin": "*",
                // The filenames are content-hashed; index.html is not.
                "Cache-Control": path.hasSuffix("index.html")
                    ? "no-cache"
                    : "public, max-age=31536000",
            ]
        )!

        // Answered synchronously and on the calling thread, deliberately.
        // These are local file reads, and responding to a WKURLSchemeTask
        // after WebKit has stopped it throws an Objective-C exception that
        // can't be caught from Swift — so never being asynchronous is the
        // simplest way to never be late.
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    public func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Nothing to cancel: `start` completes before it returns.
    }

    /// Maps a request URL onto a file inside the bundle, or nil if it escapes.
    private func resolve(url: URL) -> String? {
        let root = URL(fileURLWithPath: rootDirectory()).standardized

        var relative = url.path
        if relative.isEmpty || relative == "/" { relative = "/index.html" }

        let candidate = root.appendingPathComponent(relative).standardized

        // Containment check before touching the filesystem: without it a
        // request for /../../Library walks straight out of the bundle.
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else {
            return nil
        }

        var isDirectory: ObjCBool = false
        if FileManager.default.fileExists(atPath: candidate.path, isDirectory: &isDirectory) {
            if isDirectory.boolValue {
                return candidate.appendingPathComponent("index.html").path
            }
            return candidate.path
        }

        // Client-side routes have no file behind them. Anything without an
        // extension falls back to index.html, mirroring the rewrite our
        // Firebase Hosting config does — so a deep link resolves the same way
        // whether the app is on the bundle or the network.
        if candidate.pathExtension.isEmpty {
            return root.appendingPathComponent("index.html").path
        }

        // A hashed asset requested under a route path — /numbers/assets/x.js —
        // is a relative URL resolved against a deep route rather than the
        // bundle root. Re-anchor it at the assets directory instead of
        // refusing: refusing here means index.html loaded but none of its
        // scripts did, which renders as a white screen that only a force-quit
        // escapes. (Vite builds with an absolute base now, but the bundle that
        // is already on a device predates any fix we ship for this.)
        if let range = relative.range(of: "/assets/") {
            let reanchored = root.appendingPathComponent(String(relative[range.lowerBound...]))
                .standardized
            if reanchored.path.hasPrefix(root.path + "/"),
                FileManager.default.fileExists(atPath: reanchored.path) {
                log.info("Re-anchored \(relative) to /assets/")
                return reanchored.path
            }
        }

        return nil
    }

    private func mimeType(forPath path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json", "map": return "application/json; charset=utf-8"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff2": return "font/woff2"
        case "woff": return "font/woff"
        case "ttf": return "font/ttf"
        case "otf": return "font/otf"
        case "wasm": return "application/wasm"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        case "mp4": return "video/mp4"
        case "txt": return "text/plain; charset=utf-8"
        case "webmanifest": return "application/manifest+json"
        default: return "application/octet-stream"
        }
    }

    private func error(_ code: URLError.Code, _ description: String) -> NSError {
        NSError(
            domain: URLError.errorDomain,
            code: code.rawValue,
            userInfo: [NSLocalizedDescriptionKey: description]
        )
    }
}
