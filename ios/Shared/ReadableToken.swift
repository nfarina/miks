// @chatwing
import Foundation

extension Data {
    var apnsToken: String {
        var token: String = ""
        for i in 0..<self.count {
            token += String(format: "%02.2hhx", self[i] as CVarArg)
        }
        return token
    }
}
