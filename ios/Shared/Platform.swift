// @chatwing

struct Platform {
    static let isSimulator: Bool = {
        var isSim = false
        #if arch(i386) || arch(x86_64)
        isSim = true
        #endif
        return isSim
    }()

    static let supportsSafeArea: Bool = {
        if #available(iOS 11.0, *) {
            return true
        }
        else {
            return false
        }
    }()
}
