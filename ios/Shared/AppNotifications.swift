// @chatwing
import Foundation
import UserNotifications

/// Keeps Notification Center in step with what's unread, the same way on iOS
/// and the Mac.
///
/// A push that adds to an unread count carries that count's name as its
/// `thread-id` ("support"). Its notifications stay put while something in the
/// thread is unread, and go once it's all been read, wherever that happened:
/// the web layer reports which threads are unread whenever that changes, and
/// the server sends a background push (`clear_threads`) to every device when
/// something is read. Notifications without a thread are one-off nudges, done
/// with once the app has been opened.
enum AppNotifications {
    private static let log = Logger(prefix: "notifications")

    /// From the web layer: everything not in `unreadThreads` has been read.
    static func clearRead(unreadThreads: Set<String>) {
        Task { await remove { !$0.isEmpty && !unreadThreads.contains($0) } }
    }

    /// For when the app comes to the front.
    static func clearUnthreaded() {
        Task { await remove { $0.isEmpty } }
    }

    /// Handles the server's background push for threads read on another
    /// device, calling `completion` once they're gone. Returns false, without
    /// calling it, for any other push.
    static func handleRemoteNotification(_ userInfo: [AnyHashable: Any], completion: @escaping () -> Void) -> Bool {
        guard let value = userInfo["clear_threads"] as? String else { return false }

        let threads = Set(value.split(separator: ",").map(String.init))
        log.info("Clearing notifications read elsewhere: \(value)")

        Task {
            await remove { threads.contains($0) }
            completion()
        }
        return true
    }

    /// A badge-only push has nothing to show, and with the app in front the
    /// web layer is already keeping the badge, so it needn't be presented.
    static func isBadgeOnly(_ notification: UNNotification) -> Bool {
        let content = notification.request.content
        return content.title.isEmpty && content.body.isEmpty
    }

    /// Removes delivered notifications by their thread ("" for none).
    private static func remove(where shouldRemove: (String) -> Bool) async {
        let center = UNUserNotificationCenter.current()
        let identifiers = await center.deliveredNotifications()
            .filter { shouldRemove($0.request.content.threadIdentifier) }
            .map { $0.request.identifier }

        guard !identifiers.isEmpty else { return }
        log.debug("Removing \(identifiers.count) delivered notifications.")
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}
