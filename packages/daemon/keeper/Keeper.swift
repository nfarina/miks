// miks-keeper: keeps this Mac available while you're away from it, unlocked
// ("Stay awake, self-locked" in Settings → Remotes), so agents can use its screen
// (computer use) as well as its terminals and Chrome. The daemon starts it
// and reads what it says (a JSON line per change) from its stdout.
//
// Unlocked, but not open: once nobody's touched the Mac for as long as its
// display would stay on (or at ⌃⌘Q), a sheet goes over every screen, the
// backlight goes off, and the keyboard and trackpad do nothing until you
// unlock with Touch ID or your password. Scripted input (agents) goes on
// through. Taken from kiosk (~/Code/kiosk), which measured what's below.
//
// It fails locked, not open: unplugged, with the daemon gone, or told to
// stop while the sheet's up, it locks the Mac for real first. And without
// Accessibility it never puts the sheet up, so macOS locks as usual.
//
//   miks-keeper         Run (stdin: "shield", "quit"; EOF is the daemon gone).
//   miks-keeper lock    Lock the Mac for real, now.
//
// MIKS_KEEPER_IDLE (seconds) shortens the wait before the sheet goes up, and
// MIKS_KEEPER_TEST (seconds) takes it down by itself after that long, for
// testing without being locked out by a mistake.

import AppKit
import IOKit.ps
import LocalAuthentication
import OpenDirectory

// MARK: - The real lock

/// The lock screen, now. Private (login.framework), resolved at runtime; the
/// display going to sleep is the fallback, which locks if the Mac asks for
/// its password then.
func lockForReal() {
    typealias Lock = @convention(c) () -> Int32
    if let handle = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
       let symbol = dlsym(handle, "SACLockScreenImmediate") {
        _ = unsafeBitCast(symbol, to: Lock.self)()
        return
    }
    let sleep = Process()
    sleep.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    sleep.arguments = ["displaysleepnow"]
    try? sleep.run()
    sleep.waitUntilExit()
}

if CommandLine.arguments.dropFirst().first == "lock" {
    lockForReal()
    exit(0)
}

/// For the daemon's log (stderr), never what's typed.
func log(_ message: String) {
    FileHandle.standardError.write(Data("miks-keeper: \(message)\n".utf8))
}

// MARK: - Power

enum Power {
    /// Plugged in, rather than on battery.
    static var plugged: Bool {
        let info = IOPSCopyPowerSourcesInfo().takeRetainedValue()
        return (IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?) == kIOPSACPowerValue
    }

    /// How long the display stays on while plugged in, which is when the sheet
    /// goes up: when the Mac would have locked by itself.
    static var displaySleep: TimeInterval {
        let output = Pipe()
        let pmset = Process()
        pmset.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
        pmset.arguments = ["-g", "custom"]
        pmset.standardOutput = output
        try? pmset.run()
        pmset.waitUntilExit()
        let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        // The AC Power section's "displaysleep N" (minutes; 0 is never).
        let ac = text.components(separatedBy: "AC Power:").dropFirst().first ?? ""
        let minutes = ac.split(separator: "\n").first { $0.trimmingCharacters(in: .whitespaces).hasPrefix("displaysleep") }
            .flatMap { Double($0.split(separator: " ").last ?? "") } ?? 10
        return (minutes > 0 ? minutes : 10) * 60
    }
}

// MARK: - The backlight

/// The built-in panel's backlight, through DisplayServices (private: the
/// public IOKit API stopped working on Apple silicon). External displays
/// don't answer and are left alone; the sheet covers them. The built-in one,
/// not the main one, which is an external display's when one's attached.
enum Backlight {
    private typealias Get = @convention(c) (CGDirectDisplayID, UnsafeMutablePointer<Float>) -> Int32
    private typealias Set = @convention(c) (CGDirectDisplayID, Float) -> Int32
    private static let handle = dlopen("/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices", RTLD_LAZY)
    private static let get = handle.flatMap { dlsym($0, "DisplayServicesGetBrightness") }.map { unsafeBitCast($0, to: Get.self) }
    private static let set = handle.flatMap { dlsym($0, "DisplayServicesSetBrightness") }.map { unsafeBitCast($0, to: Set.self) }

    /// Where to bring it back to, while it's down.
    private static var restoreTo: Float?

    private static var builtIn: CGDirectDisplayID? {
        var displays = [CGDirectDisplayID](repeating: 0, count: 16)
        var count: UInt32 = 0
        CGGetOnlineDisplayList(16, &displays, &count)
        return displays.prefix(Int(count)).first { CGDisplayIsBuiltin($0) != 0 }
    }

    private static func read() -> Float? {
        var level: Float = 0
        guard let get, let display = builtIn, get(display, &level) == 0 else { return nil }
        return level
    }

    private static func write(_ level: Float) {
        guard let display = builtIn else { return }
        _ = set?(display, level)
    }

    static func off() {
        if restoreTo == nil { restoreTo = read() }
        if restoreTo != nil { write(0) }
    }

    /// Down again if something raised it (ambient light, the brightness keys).
    static func keepOff() {
        guard restoreTo != nil, let level = read(), level > 0.01 else { return }
        write(0)
    }

    static func restore() {
        guard let level = restoreTo else { return }
        restoreTo = nil
        write(level)
    }
}

// MARK: - Staying awake

/// What keeps the session going, while plugged in. Two clocks: power
/// assertions keep the Mac and its display from sleeping (the display
/// sleeping is what would lock it), but the screen saver runs on the HID idle
/// clock, which no assertion touches, and on macOS 26 neither does
/// IOPMAssertionDeclareUserActivity (kiosk measured it). A mouse move to
/// where the mouse already is does, so that, while it's past 20 seconds.
final class Awake {
    private var activity: NSObjectProtocol?
    private var heartbeat: Timer?

    /// With Accessibility, the display too and the idle clock (both of which
    /// lock it); without, only the system, which then locks as usual.
    func hold(unlocked: Bool) {
        release()
        let options: ProcessInfo.ActivityOptions = unlocked
            ? [.userInitiated, .idleSystemSleepDisabled, .idleDisplaySleepDisabled]
            : [.userInitiated, .idleSystemSleepDisabled]
        activity = ProcessInfo.processInfo.beginActivity(options: options, reason: "Miks keeps this Mac available to your other devices")
        guard unlocked else { return }
        heartbeat = Timer(timeInterval: 15, repeats: true) { _ in Awake.nudge() }
        RunLoop.main.add(heartbeat!, forMode: .common)
    }

    func release() {
        heartbeat?.invalidate()
        heartbeat = nil
        if let activity { ProcessInfo.processInfo.endActivity(activity) }
        activity = nil
    }

    private static func nudge() {
        let types: [CGEventType] = [.keyDown, .flagsChanged, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel]
        let idle = types.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
        guard idle >= 20, let location = CGEvent(source: nil)?.location else { return }
        CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .mouseMoved,
                mouseCursorPosition: location, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
}

// MARK: - The sheet

/// Black over every screen, above the menu bar and Dock, ignoring the mouse
/// (an agent's click goes to what's under it) and never taking focus. Left
/// out of screen captures, and not quite opaque: an opaque window covering
/// everything stops macOS drawing what's under it, so captures came back
/// white or missing the wallpaper and menu bar; at 99% they see it all.
final class Sheet {
    private var windows: [NSWindow] = []
    var isUp: Bool { !windows.isEmpty }

    func raise() {
        guard windows.isEmpty else { return }
        windows = NSScreen.screens.map(Sheet.window)
        NotificationCenter.default.addObserver(self, selector: #selector(screensChanged),
                                               name: NSApplication.didChangeScreenParametersNotification, object: nil)
    }

    func lower() {
        NotificationCenter.default.removeObserver(self, name: NSApplication.didChangeScreenParametersNotification, object: nil)
        for window in windows { window.orderOut(nil) }
        windows = []
    }

    @objc private func screensChanged() {
        guard isUp else { return }
        for window in windows { window.orderOut(nil) }
        windows = NSScreen.screens.map(Sheet.window)
    }

    private static func window(for screen: NSScreen) -> NSWindow {
        // Placed after: with `screen:`, the content rect counts from that
        // screen's origin, which put every screen but the main one's off it.
        let window = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.setFrame(screen.frame, display: false)
        window.isReleasedWhenClosed = false
        window.level = .screenSaver
        window.isOpaque = false
        window.backgroundColor = NSColor.black.withAlphaComponent(0.99)
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.sharingType = .none
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        window.orderFrontRegardless()
        return window
    }
}

// MARK: - Unlocking

/// A borderless panel can't take the keyboard unless it says so.
final class KeyPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// Over the sheet, once someone at the Mac touches it: Touch ID, or the
/// password for this account.
final class UnlockPanel: NSObject, NSTextFieldDelegate {
    var onUnlock: (() -> Void)?
    private var panel: KeyPanel?
    private let field = NSSecureTextField()
    private let message = NSTextField(labelWithString: "")
    private var touchID: LAContext?

    var isShowing: Bool { panel != nil }
    var frame: NSRect? { panel?.frame }

    func show() {
        guard panel == nil, let screen = NSScreen.main else { return }
        let size = NSSize(width: 320, height: 150)
        let panel = KeyPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        // Low on the screen, clear of the Touch ID dialog, which macOS centers.
        panel.setFrameOrigin(NSPoint(x: screen.frame.midX - size.width / 2, y: screen.frame.minY + screen.frame.height * 0.18))

        let title = NSTextField(labelWithString: "Locked by Miks")
        title.font = .boldSystemFont(ofSize: 15)
        title.textColor = .white
        message.font = .systemFont(ofSize: 12)
        message.textColor = NSColor.white.withAlphaComponent(0.6)
        message.stringValue = LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            ? "Touch ID or enter your password" : "Enter your password"
        field.placeholderString = "Password"
        field.delegate = self
        field.target = self
        field.action = #selector(submit)
        field.stringValue = ""

        let stack = NSStackView(views: [title, message, field])
        stack.orientation = .vertical
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 24, bottom: 20, right: 24)
        let background = NSVisualEffectView()
        background.material = .hudWindow
        background.state = .active
        background.wantsLayer = true
        background.layer?.cornerRadius = 14
        background.addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: background.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: background.trailingAnchor),
            stack.centerYAnchor.constraint(equalTo: background.centerYAnchor),
            field.widthAnchor.constraint(equalToConstant: size.width - 48),
        ])
        panel.contentView = background

        self.panel = panel
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
        askTouchID()
    }

    func hide() {
        touchID?.invalidate()
        touchID = nil
        field.stringValue = ""
        panel?.orderOut(nil)
        panel = nil
    }

    /// Back in front, after an agent put another app there.
    func refocus() {
        guard let panel else { return }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(field)
    }

    private func askTouchID() {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil) else { return }
        touchID = context
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "unlock this Mac") { [weak self] ok, _ in
            DispatchQueue.main.async {
                guard let self, self.touchID === context else { return }
                if ok {
                    log("Unlocked with Touch ID.")
                    self.onUnlock?()
                }
            }
        }
    }

    @objc private func submit() {
        let password = field.stringValue
        guard !password.isEmpty else { return }
        field.isEnabled = false
        DispatchQueue.global().async { [weak self] in
            let ok = UnlockPanel.verify(password)
            DispatchQueue.main.async {
                guard let self else { return }
                self.field.isEnabled = true
                if ok {
                    log("Unlocked with the password.")
                    self.onUnlock?()
                    return
                }
                log("Wrong password.")
                self.field.stringValue = ""
                self.message.stringValue = "Wrong password"
                self.panel?.makeFirstResponder(self.field)
            }
        }
    }

    /// This account's password, as Directory Services checks it (the
    /// authentication search path, so network and mobile accounts too).
    static func verify(_ password: String) -> Bool {
        guard let node = try? ODNode(session: ODSession.default(), type: ODNodeType(kODNodeTypeAuthentication)),
              let record = try? node.record(withRecordType: kODRecordTypeUsers, name: NSUserName(), attributes: nil)
        else { return false }
        return (try? record.verifyPassword(password)) != nil
    }
}

// MARK: - The keyboard and trackpad

/// Every event, before any app sees it. Hardware's (a source pid of 0) is a
/// person at the Mac; anything posted (an agent, the nudge above) carries the
/// poster's pid. Screen sharing posts too, but is a person.
final class Input {
    enum Mode { case watching, blocking, unlocking }
    var mode: Mode = .watching

    /// A person at the Mac touched it while the sheet's up.
    var onWake: (() -> Void)?
    /// ⌃⌘Q, the lock screen's shortcut, from the keyboard.
    var onLockKey: (() -> Void)?
    /// Where unlocking takes clicks, in the tap's coordinates (top-left origin).
    var panelFrame: (() -> CGRect?)?
    var lastPerson = Date()

    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    var isActive: Bool { tap != nil }

    private static let remoteNames: Set<String> = ["screensharingd", "ScreensharingAgent", "AppleVNCServer", "ARDAgent"]
    private var remotePids: [pid_t: Bool] = [:]

    func start() -> Bool {
        guard tap == nil else { return true }
        let types: [CGEventType] = [
            .keyDown, .keyUp, .flagsChanged, .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
            .otherMouseDown, .otherMouseUp, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
        ]
        // Plus system-defined events (14): media, volume and dictation keys.
        let mask = types.reduce(CGEventMask(1 << 14)) { $0 | (1 << CGEventMask($1.rawValue)) }
        let callback: CGEventTapCallBack = { _, type, event, refcon in
            Unmanaged<Input>.fromOpaque(refcon!).takeUnretainedValue().handle(type, event)
        }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                          eventsOfInterest: mask, callback: callback,
                                          userInfo: Unmanaged.passUnretained(self).toOpaque())
        else { return false }
        self.tap = tap
        source = CFMachPortCreateRunLoopSource(nil, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return true
    }

    /// A new tap, after the real lock screen, in case the old one stopped
    /// getting events there without saying so. (One started at the lock
    /// screen did still work once unlocked; this is only in case.)
    func restart() {
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
            CFMachPortInvalidate(tap)
        }
        tap = nil
        source = nil
        _ = start()
    }

    /// Back on if macOS turned it off without telling us.
    func keepEnabled() {
        if let tap, !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
    }

    private func isPerson(_ pid: pid_t) -> Bool {
        if pid == 0 { return true }
        if let known = remotePids[pid] { return known }
        var name = [CChar](repeating: 0, count: 256)
        let remote = proc_name(pid, &name, UInt32(name.count)) > 0 && Input.remoteNames.contains(String(cString: name))
        if remotePids.count > 64 { remotePids.removeAll() }
        remotePids[pid] = remote
        return remote
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) -> Unmanaged<CGEvent>? {
        // macOS turns off a tap that's slow to answer; on again, or the lock is gone.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return nil
        }
        let pid = pid_t(event.getIntegerValueField(.eventSourceUnixProcessID))
        if isPerson(pid) { lastPerson = Date() }
        guard pid == 0 else { return Unmanaged.passUnretained(event) }

        let flags = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        switch mode {
        case .watching:
            if type == .keyDown, event.getIntegerValueField(.keyboardEventKeycode) == 12 /* Q */,
               flags == [.maskCommand, .maskControl] {
                DispatchQueue.main.async { self.onLockKey?() }
                return nil
            }
            return Unmanaged.passUnretained(event)
        case .blocking:
            if [.keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown].contains(type) {
                DispatchQueue.main.async { self.onWake?() }
            }
            return nil
        case .unlocking:
            return unlocking(type, event, flags) ? Unmanaged.passUnretained(event) : nil
        }
    }

    /// While the password panel's up: typing into it (no ⌘ shortcuts but
    /// editing ones, so nothing can switch apps), and clicks on it. The
    /// pointer moves, so it can get there.
    private func unlocking(_ type: CGEventType, _ event: CGEvent, _ flags: CGEventFlags) -> Bool {
        switch type {
        case .mouseMoved:
            return true
        case .keyDown, .keyUp:
            guard NSRunningApplication.current.isActive else {
                DispatchQueue.main.async { self.onWake?() }
                return false
            }
            // A, C, V, X, Z: select all, copy, paste, cut, undo.
            let editing: Set<Int64> = [0, 8, 9, 7, 6]
            return !flags.contains(.maskCommand) || editing.contains(event.getIntegerValueField(.keyboardEventKeycode))
        case .flagsChanged:
            return true
        case .leftMouseDown, .leftMouseUp, .leftMouseDragged:
            guard let frame = panelFrame?() else { return false }
            return frame.contains(event.location)
        default:
            return false
        }
    }
}

// MARK: - Keeper

final class Keeper {
    private let awake = Awake()
    private let sheet = Sheet()
    private let input = Input()
    private let unlock = UnlockPanel()
    private var plugged = Power.plugged
    private var watchdog: Timer?
    private var reported = ""
    private let idleOverride = ProcessInfo.processInfo.environment["MIKS_KEEPER_IDLE"].flatMap(Double.init)
    /// How long without a person before the sheet goes up: the display-sleep
    /// time, read again each minute, so a change in System Settings counts.
    private lazy var idle = idleOverride ?? Power.displaySleep
    private var idleReadAt = Date()
    private let testFor = ProcessInfo.processInfo.environment["MIKS_KEEPER_TEST"].flatMap(Double.init)

    /// Whether the sheet can go up: plugged in, and holding the keyboard.
    private var armed: Bool { plugged && input.isActive }

    func start() {
        _ = input.start()
        input.onWake = { [weak self] in self?.wake() }
        // Taken from macOS, so on battery (no sheet then) it locks for real, as macOS would have.
        input.onLockKey = { [weak self] in
            guard let self else { return }
            if self.armed { self.raise() } else { lockForReal() }
        }
        input.panelFrame = { [weak self] in
            // AppKit's origin is the bottom left of the main screen; the tap's, its top left.
            guard let frame = self?.unlock.frame, let height = NSScreen.screens.first?.frame.height else { return nil }
            return CGRect(x: frame.minX, y: height - frame.maxY, width: frame.width, height: frame.height)
        }
        unlock.onUnlock = { [weak self] in self?.lower() }
        follow()

        // Power changes.
        let source = IOPSNotificationCreateRunLoopSource({ _ in keeper.powerChanged() }, nil).takeRetainedValue()
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)

        // Unlocked from the real lock screen: a new tap, in case.
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            log("Unlocked: watching the keyboard afresh.")
            self?.input.restart()
            self?.report()
        }
        // Waking resets the backlight; and Accessibility granted later arms it.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in
            if self?.sheet.isUp == true, self?.unlock.isShowing == false { Backlight.off() }
        }
        // At most 30s, so a display-sleep time shortened later is kept to closely enough.
        let tick = Timer(timeInterval: min(30, max(1, idle / 4)), repeats: true) { [weak self] _ in self?.check() }
        RunLoop.main.add(tick, forMode: .common)

        // The daemon's word, and its going (EOF): locked for real if the sheet's up.
        FileHandle.standardInput.readabilityHandler = { handle in
            let data = handle.availableData
            DispatchQueue.main.async {
                guard !data.isEmpty else { return self.quit() }
                for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
                    if line == "shield", self.armed { self.raise() }
                    if line == "quit" { self.quit() }
                }
            }
        }
        for signal in [SIGTERM, SIGINT, SIGHUP] {
            Darwin.signal(signal, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: signal, queue: .main)
            source.setEventHandler { self.quit() }
            source.resume()
            signals.append(source)
        }
        report()
    }

    private var signals: [DispatchSourceSignal] = []

    private func follow() {
        if plugged { awake.hold(unlocked: input.isActive) } else { awake.release() }
    }

    private func powerChanged() {
        let now = Power.plugged
        guard now != plugged else { return }
        plugged = now
        // Unplugged with the sheet up: it may be leaving with someone.
        if !plugged, sheet.isUp { lockAndLower() }
        follow()
        report()
    }

    private func check() {
        input.keepEnabled()
        if !input.isActive, AXIsProcessTrusted(), input.start() {
            follow()
            report()
        }
        if sheet.isUp {
            // Gave up on unlocking: dark again.
            if unlock.isShowing, Date().timeIntervalSince(input.lastPerson) > 30 { dim() }
            return
        }
        if idleOverride == nil, Date().timeIntervalSince(idleReadAt) >= 60 {
            idleReadAt = Date()
            let now = Power.displaySleep
            if now != idle { log("The display now sleeps after \(Int(now / 60)) min: the screen goes dark then.") }
            idle = now
        }
        if armed, Date().timeIntervalSince(input.lastPerson) >= idle { raise() }
    }

    func raise() {
        guard !sheet.isUp else { return }
        sheet.raise()
        Backlight.off()
        input.mode = .blocking
        watchdog = Timer(timeInterval: 30, repeats: true) { _ in Backlight.keepOff() }
        RunLoop.main.add(watchdog!, forMode: .common)
        if let testFor {
            DispatchQueue.main.asyncAfter(deadline: .now() + testFor) {
                if self.sheet.isUp { log("Test over: down by itself.") }
                self.lower()
            }
        }
        report()
    }

    /// Someone at the Mac: the backlight up and the password panel.
    private func wake() {
        guard sheet.isUp else { return }
        if unlock.isShowing { return unlock.refocus() }
        log("Someone's at the Mac: asking to unlock.")
        input.mode = .unlocking
        input.lastPerson = Date()
        Backlight.restore()
        unlock.show()
    }

    private func dim() {
        unlock.hide()
        input.mode = .blocking
        Backlight.off()
    }

    func lower() {
        guard sheet.isUp else { return }
        watchdog?.invalidate()
        watchdog = nil
        unlock.hide()
        input.mode = .watching
        input.lastPerson = Date()
        Backlight.restore()
        // The backlight first, so the desktop comes up on a lit screen.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
            guard self.input.mode == .watching else { return }
            self.sheet.lower()
            self.report()
        }
    }

    /// The lock screen comes up over the sheet; then it can go.
    private func lockAndLower() {
        lockForReal()
        watchdog?.invalidate()
        watchdog = nil
        unlock.hide()
        input.mode = .watching
        Backlight.restore()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
            self.sheet.lower()
            self.report()
        }
    }

    func quit() {
        if sheet.isUp {
            lockForReal()
            Backlight.restore()
        }
        awake.release()
        exit(0)
    }

    private func report() {
        let line = "{\"accessibility\":\(input.isActive),\"plugged\":\(plugged),\"shielded\":\(sheet.isUp)}"
        guard line != reported else { return }
        reported = line
        print(line)
        fflush(stdout)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let keeper = Keeper()
keeper.start()
app.run()
