// @chatwing
import Foundation

extension Date {
    var jsTimestamp: Int64 {
        return Int64(self.timeIntervalSince1970 * 1000)
    }

    init(jsTimestamp: Int64) {
        self.init(timeIntervalSince1970: Double(jsTimestamp) / 1000)
    }
}
