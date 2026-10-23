// @chatwing
import Foundation
import ZipArchive

//
// WebBundle Manager Class
//

protocol WebBundleDelegate {
    func webBundleDidMakeProgress(progress: Float)
    func webBundleDidDownloadNewBundle(_ bundle:WebBundle)
    func webBundleUpToDate(_ bundle:WebBundle)
    func webBundleDidFailDownloadingNewBundle(_ bundle:WebBundle)
}

class WebBundle: NSObject, SSZipArchiveDelegate {

    private let log = Logger(prefix: "webbundle")

    private let CheckInterval:TimeInterval = 30 // seconds

    var delegate: WebBundleDelegate

    private var checkingForNewBundle = false
    private var bundleIsDownloading = false

    required init(delegate:WebBundleDelegate) {
        self.delegate = delegate
        super.init()

        // If we don't have a local bundle at all, download one immediately.
        if (!localBundleExists) {
            downloadBundle()
        }

        // Begin checking for new bundle versions periodically.
        checkForNewBundle()
    }

    static var documentsDirectory:String {
        return NSSearchPathForDirectoriesInDomains(.documentDirectory, .userDomainMask, true)[0]
    }

    /// Where the unpacked bundle lives. Static so the scheme handler can find
    /// it without holding a WebBundle, and so there's one definition of it.
    static var distDirectory:String {
        return (documentsDirectory as NSString).appendingPathComponent("dist")
    }

    var documentsDirectory:String { WebBundle.documentsDirectory }

    var distDirectory:String { WebBundle.distDirectory }

    var unzipDirectory:String {
        return (documentsDirectory as NSString).appendingPathComponent("dist_unzip")
    }

    var bundleZipPath:String {
        return (documentsDirectory as NSString).appendingPathComponent("bundle.zip")
    }

    var bundleJsonPath:String {
        return (distDirectory as NSString).appendingPathComponent("bundle.json")
    }

    /// Loading the bundle straight off disk. Works, but the page ends up with
    /// a null origin — see WebBundleSchemeHandler for what that costs.
    var applicationFileURL:String {
        return "file://\(distDirectory)/index.html"
    }

    /// The same bundle behind a real origin. Prefer this: it is the only one
    /// of the two where AudioWorklets, ES modules and origin-scoped storage
    /// actually work.
    var applicationURL:String {
        return "\(WebBundleScheme)://\(WebBundleSchemeHost)/index.html"
    }

    var localBundleExists:Bool {
        var isDirectory:ObjCBool = false
        let exists = FileManager.default.fileExists(atPath: distDirectory, isDirectory: &isDirectory)
        guard exists && isDirectory.boolValue else { return false }

        // Check for a bundle.json file.
        return FileManager.default.fileExists(atPath: bundleJsonPath)
    }

    func checkForNewBundleLater() {
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(checkForNewBundle), object: nil)
        self.perform(#selector(checkForNewBundle), with: nil, afterDelay: CheckInterval)
    }

    func localHash() -> String? {
        if FileManager.default.fileExists(atPath: bundleJsonPath) {

            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: bundleJsonPath), options: .mappedIfSafe)
                let jsonResult = try JSONSerialization.jsonObject(with: data, options: .mutableLeaves)
                if let jsonResult = jsonResult as? Dictionary<String, AnyObject>, let hash = jsonResult["hash"] as? String {
                    return hash
                }
                else {
                    return nil
                }
            }
            catch let error as NSError {
                log.error("Error reading local bundle.json.", error)
                return nil
            }
        }
        else { return nil }
    }

    @objc func checkForNewBundle() {
        // If a check or download is already in progress, then defer checking this round.
        guard !checkingForNewBundle && !bundleIsDownloading else {
            checkForNewBundleLater()
            return
        }

        checkingForNewBundle = true

        let bundleJsonURL = URL(string: clientUrl)!.appendingPathComponent("bundle.json")

        log.debug("Checking for new bundle at \(bundleJsonURL.absoluteString)...")

        let session = URLSession(
            configuration: URLSessionConfiguration.default,
            delegate: nil, delegateQueue: OperationQueue.main)

        session.dataTask(with: bundleJsonURL, completionHandler: {
            data, response, error in

            guard error == nil else {
                self.log.error("Error checking for new bundle.", error)
                self.checkingForNewBundle = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            guard let response = response as? HTTPURLResponse else {
                self.log.error("Response was not an HTTPURLResponse!")
                self.checkingForNewBundle = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            guard response.statusCode == 200 else {
                self.log.error("Bad response code \(response.statusCode).", error)
                self.checkingForNewBundle = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            self.checkingForNewBundle = false

            guard let jsonResult = try? JSONSerialization.jsonObject(with: data!, options: .mutableLeaves) else {
                self.finishManualChecks(.failed)
                return
            }

            guard let bundle = jsonResult as? Dictionary<String, AnyObject>, let newHash = bundle["hash"] as? String else {
                // Not sure why this is considered fatal - I wrote this a while ago. Maybe there's no good reason for it anymore?
                self.log.error("Problem decoding bundle.json (FATAL - not retrying!)")
                self.finishManualChecks(.failed)
                return
            }

            guard let currentHash = self.localHash() else {
                self.finishManualChecks(.failed)
                return
            }

            if newHash != currentHash {
                self.log.info("New version available: \(newHash) [local version \(currentHash)].")
                self.finishManualChecks(.downloading)
                self.downloadBundle()
            }
            else {
                self.log.debug("Local bundle is up to date. Will check again later.")
                self.checkForNewBundleLater()
                self.bundleUpToDate()
            }

        }) .resume()
    }

    private func downloadBundle() {
        let sizeURL = URL(string: "/bundle.zip.size", relativeTo: URL(string: clientUrl))!

        log.info("Fetching bundle size from \(sizeURL.absoluteString)")

        let session = URLSession(
            configuration: URLSessionConfiguration.default,
            delegate: nil, delegateQueue: OperationQueue.main)

        session.dataTask(with: sizeURL) { data, response, error in
            guard error == nil else {
                self.log.error("Error fetching web bundle size. Rescheduling download check.", error)
                self.bundleIsDownloading = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            guard let response = response as? HTTPURLResponse else {
                self.log.error("Response was not an HTTPURLResponse!")
                self.bundleIsDownloading = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            guard response.statusCode == 200 else {
                self.log.error("Bad response code \(response.statusCode).", error)
                self.bundleIsDownloading = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            guard let data = data,
                let string = String(data: data, encoding: .utf8),
                let size = Float(string.trimmingCharacters(in: .whitespacesAndNewlines))
                else {
                // See related comment in checkForNewBundle()
                self.log.error("Problem parsing bundle size result (FATAL - not retrying!).")
                self.bundleIsDownloading = false
                self.bundleFailed()
                return
            }

            self.downloadBundleWithSize(size: size)
        } .resume()
    }

    private func downloadBundleWithSize(size: Float) {
        log.info("Downloading new bundle to \(bundleZipPath) with expected size \(size)")

        bundleIsDownloading = true

        deleteIfExists(bundleZipPath)

        let downloader = WebBundleDownloader(
            downloadPath: bundleZipPath,
            expectedSize: size,
            delegate: delegate
        ) { error in

            guard error == nil else {
                self.log.error("Error downloading web bundle. Rescheduling download check.", error)
                self.bundleIsDownloading = false
                self.checkForNewBundleLater()
                self.bundleFailed()
                return
            }

            self.unpackBundle()
        }
        downloader.download()
    }

    func unpackBundle() {
        log.info("Unpacking web bundle...")

        deleteIfExists(unzipDirectory)

        // Execute the unzip operation itself in a background thread, classified as a "user initiated" operation, which whatever, the
        // app literally isn't doing anything else so this priority stuff is way unnecessary anyway.
        DispatchQueue.global(qos: .userInitiated).async {
            SSZipArchive.unzipFile(
                atPath: self.bundleZipPath,
                toDestination: self.unzipDirectory,
                progressHandler: self.zipProgressHandler,
                completionHandler: self.zipCompletionHandler)
        }
    }

    func zipProgressHandler(entry:String, zipInfo:unz_file_info, entryNumber:Int, total:Int) {

        // log.debug("Zip progress: \(entryNumber)/\(total)")

        // Unzipping accounts for remaining 20% of the total progress bar.
        let unzipProgress = Float(entryNumber) / Float(total)
        let totalProgress = 0.8 + unzipProgress * (20.0/100.0)

        // Call this synchronously so we don't overload the main thread with lots of progress updates to catch up on after we've already finished.
        DispatchQueue.main.sync {
            self.delegate.webBundleDidMakeProgress(progress: totalProgress)
        }
    }

    func zipCompletionHandler(path:String, succeeded:Bool, error:Error?) {

        // This one can be async because the unzip is complete.
        DispatchQueue.main.async {
            if !succeeded {
                self.log.error("Problem unzipping web bundle. Not retrying. Error: \(String(describing: error))")
                self.bundleIsDownloading = false
                self.bundleFailed()
                return
            }

            // Move the unzipped directory into place.
            do {
                deleteIfExists(self.distDirectory)

                // We expect the zipfile to have contained a single "dist" directory. That's what we want.
                let unzippedDistDirectory = (self.unzipDirectory as NSString).appendingPathComponent("dist")

                try FileManager.default.moveItem(atPath: unzippedDistDirectory, toPath: self.distDirectory)

                // OK, we're done!
                self.log.info("New bundle is ready.")
                self.bundleIsDownloading = false
                self.bundleReady()

                // Check again later.
                self.checkForNewBundleLater()
            }
            catch let error as NSError {
                self.log.error("Problem moving the unzipped web bundle into place. This is fatal. Bye!", error)
                self.bundleIsDownloading = false
                self.bundleFailed()
            }
        }
    }

    func bundleReady() {
        delegate.webBundleDidDownloadNewBundle(self)
    }

    func bundleUpToDate() {
        finishManualChecks(.upToDate)
        delegate.webBundleUpToDate(self)
    }

    func bundleFailed() {
        finishManualChecks(.failed)
        delegate.webBundleDidFailDownloadingNewBundle(self)
    }

    //
    // Checking on request
    //

    enum CheckResult {
        /// Nothing newer than what we have.
        case upToDate
        /// A newer bundle is on its way down; the delegate hears when it lands.
        case downloading
        case failed
    }

    private var manualChecks: [(CheckResult) -> Void] = []

    /// Checks for a new bundle now rather than on the next periodic tick, and
    /// reports what it found. For when someone asked.
    func checkNow(_ completion: @escaping (CheckResult) -> Void) {
        if bundleIsDownloading {
            completion(.downloading)
            return
        }

        manualChecks.append(completion)

        // A check already in flight will answer for us.
        if !checkingForNewBundle {
            NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(checkForNewBundle), object: nil)
            checkForNewBundle()
        }
    }

    private func finishManualChecks(_ result: CheckResult) {
        let completions = manualChecks
        manualChecks = []
        for completion in completions { completion(result) }
    }
}

//
// Downloader
//

class WebBundleDownloader: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionDownloadDelegate {

    private let log = Logger(prefix: "webbundle_downloader")

    let downloadPath: String
    let expectedSize: Float
    let delegate:WebBundleDelegate
    let completionHandler: (NSError?) -> Void

    var session:Foundation.URLSession!
    var downloadTask:URLSessionDownloadTask!

    required init(
        downloadPath: String,
        expectedSize: Float,
        delegate: WebBundleDelegate,
        completion: @escaping (NSError?) -> Void
    ) {
        self.downloadPath = downloadPath
        self.expectedSize = expectedSize
        self.delegate = delegate
        self.completionHandler = completion
        super.init()
    }

    func download() {
        session = Foundation.URLSession(configuration: URLSessionConfiguration.default,
                                        delegate: self,
                                        delegateQueue: OperationQueue.main)

        let zipURL = URL(string: "/bundle.zip", relativeTo: URL(string: clientUrl))!

        log.info("Downloading new bundle from \(zipURL.absoluteString)")

        downloadTask = session.downloadTask(with: zipURL)
        downloadTask.resume()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didResumeAtOffset fileOffset: Int64, expectedTotalBytes: Int64) {
        log.info("Resumed at \(fileOffset)")
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {

        // We can't trust totalBytesExpectedtoWrite because our hosting provider doesn't provide a Content-Length header.

//        log.debug("Wrote \(bytesWritten) bytes.")

        // Download accounts for 80% of the total progress bar.
        let downloadProgress = Float(totalBytesWritten) / Float(expectedSize)
        let totalProgress = downloadProgress * (80.0/100.0)
        delegate.webBundleDidMakeProgress(progress: totalProgress)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {

        log.info("Downloaded to \(location)")

        do {
            try FileManager.default.moveItem(atPath: location.path, toPath: downloadPath)
            completionHandler(nil)
        }
        catch let error as NSError {
            completionHandler(error)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if error != nil {
            log.error("Download finished with error \(String(describing: error))")
            completionHandler(error as NSError?)
        }
    }
}

//
// Utils
//

private func deleteIfExists(_ path:String) {
    if FileManager.default.fileExists(atPath: path) {
        do {
            try FileManager.default.removeItem(atPath: path)
        }
        catch let error as NSError {
            log.debug("Could not delete item at path \(path): \(error)")
        }
    }
}
