// @chatwing
import Foundation

/// Handoff between the iOS and Mac apps: each advertises the page it's on, so
/// the other device offers to pick up there (the app switcher's banner on an
/// iPhone, a badged Dock icon on a Mac).
///
/// It needs no entitlement, only both apps signed by the same team and the
/// activity type in each one's `NSUserActivityTypes`.
enum Handoff {
    /// Must match `NSUserActivityTypes` in both apps' Info.plists.
    static let activityType = (Bundle.main.bundleIdentifier ?? "") + ".page"

    /// An activity for a page of the web app, or nil if there's nothing to
    /// advertise.
    ///
    /// The page's own URL won't do: a bundled web app has only a local one. And
    /// the web app sends us its router's path because the web view's URL
    /// doesn't follow along at all, since a bundle navigates with MemoryHistory.
    static func activity(forPath path: String?) -> NSUserActivity? {
        guard let path, path.hasPrefix("/"),
              let base = URL(string: clientUrl),
              let url = URL(string: path, relativeTo: base)?.absoluteURL
        else { return nil }

        let activity = NSUserActivity(activityType: activityType)
        activity.webpageURL = url
        return activity
    }
}

extension NSUserActivity {
    /// The app path to open for this activity. The web app's deep links are
    /// paths, and it ignores anything else.
    var appPath: String? {
        guard let url = webpageURL else { return nil }
        return url.path + (url.query.map { "?\($0)" } ?? "")
    }
}
