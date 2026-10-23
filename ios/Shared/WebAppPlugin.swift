// @chatwing
import Foundation

class WebAppPlugin: NSObject {
    let webApp: WebAppViewController

    init(webApp: WebAppViewController) {
        self.webApp = webApp
        super.init()
    }

    // Define a readonly name property that subclasses must implement.
    var name: String {
        fatalError("WebAppPlugin subclasses must override name")
    }

    // Define a readonly features property that subclasses can implement
    // but defaults to an empty map.
    var features: [String: Any] {
        return [:]
    }

    func handleMessage(name: String, body: [String: Any]) -> Bool {
        fatalError("WebAppPlugin subclasses must override handleMessage()")
    }

    // Called when the web page's process dies and is about to be reloaded (or
    // will be, once we're foregrounded). The page that learns of it is the
    // next one, so anything worth reporting has to be kept until it asks.
    func webContentProcessDidTerminate() {}

    func sendToPluginListener(_ handler: String, args: String = "undefined", callback: (([String: Any]) -> Void)? = nil) {
        // Prepend our plugin name to the handler and outsource the rest to webApp.
        webApp.sendToWindowListener("\(name)_\(handler)", args: args, callback: callback)
    }
}
