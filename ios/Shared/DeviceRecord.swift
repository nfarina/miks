// @chatwing
import Foundation
// Firebase is optional: without it, the device record goes nowhere.
#if canImport(FirebaseFirestore)
import FirebaseAuth
import FirebaseFirestore
#endif

private var CachedDeviceIdentifier = ""

public func DeviceIdentifier() -> String {
    if CachedDeviceIdentifier != "" {
        return CachedDeviceIdentifier
    }

    let identifier = UserDefaults.standard.string(forKey: "deviceId")

    if let identifier = identifier {
        print("Using previously-generated device ID \(identifier)")
        CachedDeviceIdentifier = identifier
        return identifier
    }
    else {
        let newIdentifier = UUID().uuidString
        print("Writing new device ID \(newIdentifier)")
        UserDefaults.standard.setValue(newIdentifier, forKey: "deviceId")
        CachedDeviceIdentifier = newIdentifier
        return newIdentifier
    }
}

let Device = DeviceRecord()

#if canImport(FirebaseFirestore)

public class DeviceRecord {
    private var initialized = false

    // Captures any device info captured before we are connected to firebase.
    private var pendingRecord = [String: Any]()

    private var documentRef:DocumentReference?

    // Whether this device should send logs to Firestore. Set from admin UI.
    var loggingEnabled = false

    // Polls the device document every 30s to pick up loggingEnabled changes.
    private var pollTimer: Timer?

    private func start(user: User) {
        if self.documentRef != nil { stop() }

        self.documentRef = Firestore.firestore()
            .collection("devices")
            .document(DeviceIdentifier())

        guard let documentRef = self.documentRef else { return }

        // Add any pending info.
        var finalRecord = pendingRecord
        finalRecord["userId"] = user.uid
        documentRef.setData(finalRecord, merge: true)
        pendingRecord.removeAll()

        // Read immediately, then poll every 30s. Timer automatically pauses when backgrounded.
        refreshLoggingEnabled()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            self?.refreshLoggingEnabled()
        }
    }

    private func refreshLoggingEnabled() {
        documentRef?.getDocument { (document, error) in
            if let document = document, document.exists {
                self.loggingEnabled = document.data()?["loggingEnabled"] as? Bool ?? false
            }
        }
    }

    private func stop() {
        pollTimer?.invalidate()
        pollTimer = nil
        self.documentRef = nil
        self.loggingEnabled = false
    }

    func update(_ record: [String: Any]) {
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

        if let documentRef = self.documentRef {
            documentRef.setData(record, merge: true)
        }
        else {
            for item in record {
                pendingRecord[item.key] = item.value
            }
        }
    }
}

#else

/// Without Firebase: the same calls, kept nowhere.
public class DeviceRecord {
    var loggingEnabled = false

    func update(_ record: [String: Any]) {}
}

#endif
