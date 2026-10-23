// @chatwing
import Foundation
// Firebase is optional: an app that doesn't link it logs to the console only.
#if canImport(FirebaseFirestore)
import FirebaseAuth
import FirebaseFirestore
#endif

//
// Quick generic logging "Framework"
//

// Global convenience logging object.
let GlobalLogger = Logger(prefix: nil)

// Make the log command everywhere by default unless you reclare it in a file or class.
let log = GlobalLogger

let startTime = Date().jsTimestamp

enum LoggingLevel {
    case debug // only prints to console
    case info
    case warning
    case error
}

class Logger {
    let prefix: String?

    init(prefix: String?) {
        self.prefix = prefix
    }

    func log(_ level: LoggingLevel, _ message: String, prefix: String? = nil, error:Error? = nil) {

        var formattedMessage = message
        let resolvedPrefix = prefix ?? self.prefix

        if error != nil {
            formattedMessage = "\(formattedMessage) Error: \(String(describing: error))"
        }

        var prefixedMessage = formattedMessage

        if let resolvedPrefix = resolvedPrefix {
            prefixedMessage = "\(resolvedPrefix): \(formattedMessage)"
        }

        // Always print the message to the console.
        print("\(prefixedMessage) [\(Date().jsTimestamp - startTime)ms]")

        // If it's anything but Debug, send it to Firestore.
        #if canImport(FirebaseFirestore)
        if level != .debug {
            DeviceFirestoreLogger.logMessage(formattedMessage, level: level, prefix: resolvedPrefix)
        }
        #endif
    }

    func debug(_ message: String) { log(.debug, message) }
    func info(_ message: String) { log(.info, message) }
    func info(_ message: String, prefix: String?) { log(.info, message, prefix: prefix) }
    func warn(_ message: String) { log(.warning, message) }
    func error(_ message: String, _ error:Error? = nil) { log(.error, message, error: error) }
}

#if canImport(FirebaseFirestore)

//
// Firestore-based logging system
//

let MaxLogs = 250
let MaxMessageLength = 1024

let DeviceFirestoreLogger = FirestoreLogger(deviceId: DeviceIdentifier())

class FirestoreLogger {
    private var initialized = false

    // Captures any logs that occur before we are connected to firebase.
    private var pendingLogs = [LogRecord]()

    private var user: User?

    private var deviceId: String

    init(deviceId:String) {
        self.deviceId = deviceId
    }

    func start(user: User) {
        self.user = user

        // Only flush pending logs if logging is enabled for this device.
        guard Device.loggingEnabled else {
            pendingLogs.removeAll()
            return
        }

        let logsRef = Firestore.firestore().collection("deviceLogs")

        // Add any pending logs.
        let batch = Firestore.firestore().batch()
        for record in pendingLogs {
            let data = record.firestoreRecord(user: user, deviceId: self.deviceId)
            batch.setData(data, forDocument: logsRef.document())
        }
        batch.commit()
        pendingLogs.removeAll()
    }

    func stop() {
        self.user = nil
    }

    func logMessage(_ message: String, level: LoggingLevel, prefix: String?) {
        if !initialized {
            Auth.auth().addStateDidChangeListener { (auth, user) in
                if let user = user {
                    self.start(user: user)
                }
                else {
                    self.stop()
                }
            }
            initialized = true
        }

        // Trim message so it's not crazy huge.
        let trimmed = String(message.prefix(MaxMessageLength))

        let record = LogRecord(created: Date(), level: level, prefix: prefix, message: trimmed)

        if let user = user {
            // Only write to Firestore if logging is enabled for this device.
            if Device.loggingEnabled {
                let data = record.firestoreRecord(user: user, deviceId: self.deviceId)

                Firestore.firestore()
                    .collection("deviceLogs")
                    .document()
                    .setData(data)
            }
        }
        else {
            pendingLogs.append(record)

            // Rotate pending entries if necessary
            while pendingLogs.count > MaxLogs { pendingLogs.removeFirst() }
        }
    }
}

struct LogRecord {
    let created: Date
    let level: LoggingLevel
    let prefix: String?
    let message: String

    func firestoreRecord(user: User, deviceId: String) -> [String: Any] {
        return [
            // Log schema version. Must match the version required by the
            // deviceLogs rule in firestore.rules, otherwise writes are denied.
            "version": 2,
            "userId": user.uid,
            "deviceId": deviceId,
            "created": created.jsTimestamp,
            "level": String(describing: level),
            "prefix": prefix as Any,
            "message": message,
            // Set the expiration date of this document to be 30 days from now.
            "deleteDate": Date().addingTimeInterval(60 * 60 * 24 * 30)
        ]
    }
}

#endif
