// What macOS lets programs in Miks's terminals do, for Permissions.ts:
// `osascript -l JavaScript permissions.js status` prints every permission's
// status as JSON, and `… request <id>` asks for one, returning once it's
// answered. Run by the daemon, so macOS takes it for the daemon (Miks
// Helper), which is who every program in its terminals counts as.

ObjC.import("Foundation");

// TCCAccessPreflight is private, but it answers for every service without
// ever asking: 0 is granted, 1 denied (or off), 2 not asked yet.
$.NSBundle.bundleWithPath("/System/Library/PrivateFrameworks/TCC.framework").load;
ObjC.bindFunction("TCCAccessPreflight", ["int", ["id", "id"]]);

const TCC_SERVICES = {
  desktop: "SystemPolicyDesktopFolder",
  documents: "SystemPolicyDocumentsFolder",
  downloads: "SystemPolicyDownloadsFolder",
  fullDisk: "SystemPolicyAllFiles",
  camera: "Camera",
  microphone: "Microphone",
  contacts: "AddressBook",
  calendars: "Calendar",
  reminders: "Reminders",
  photos: "Photos",
  bluetooth: "BluetoothAlways",
  accessibility: "Accessibility",
  screen: "ScreenCapture",
  input: "ListenEvent",
  developerTools: "DeveloperTool",
  appManagement: "SystemPolicyAppBundles",
};

const AUTOMATION_TARGETS = {
  systemEvents: "com.apple.systemevents",
  finder: "com.apple.finder",
  notes: "com.apple.Notes",
};

function run(argv) {
  const [mode, id] = argv;
  if (mode === "status") return JSON.stringify(status());
  if (mode === "request") return JSON.stringify({ answered: request(id) });
  throw new Error("Usage: permissions.js status | request <id>");
}

function status() {
  const result = {};
  for (const [id, service] of Object.entries(TCC_SERVICES)) {
    result[id] = ["granted", "denied", "notAsked"][$.TCCAccessPreflight($("kTCCService" + service), null)] ?? "unknown";
  }

  // Apple Events are per app, and only answerable while it runs (-600).
  ObjC.import("CoreServices");
  ObjC.bindFunction("AEDeterminePermissionToAutomateTarget", ["int", ["pointer", "unsigned int", "unsigned int", "bool"]]);
  for (const [id, bundleId] of Object.entries(AUTOMATION_TARGETS)) {
    const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(bundleId);
    const answer = $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false);
    result[id] = answer === 0 ? "granted" : answer === -1743 ? "denied" : answer === -1744 ? "notAsked" : "unknown";
  }
  return result;
}

/** Asks for one, returning whether it was answered (not left waiting). */
function request(id) {
  // Completion handlers never run here (macOS calls them on a queue of its
  // own, which JXA doesn't take), so it's TCC that says when it's answered.
  const service = TCC_SERVICES[id];
  const answered = () => $.TCCAccessPreflight($("kTCCService" + service), null) !== 2;
  const ignore = () => {};

  switch (id) {
    case "camera":
    case "microphone":
      ObjC.import("AVFoundation");
      $.NSClassFromString("AVCaptureDevice").requestAccessForMediaTypeCompletionHandler(
        id === "camera" ? "vide" : "soun",
        ignore,
      );
      break;
    case "contacts":
      ObjC.import("Contacts");
      $.CNContactStore.alloc.init.requestAccessForEntityTypeCompletionHandler(0, ignore);
      break;
    case "calendars":
      ObjC.import("EventKit");
      $.EKEventStore.alloc.init.requestFullAccessToEventsWithCompletion(ignore);
      break;
    case "reminders":
      ObjC.import("EventKit");
      $.EKEventStore.alloc.init.requestFullAccessToRemindersWithCompletion(ignore);
      break;
    case "photos":
      ObjC.import("Photos");
      $.PHPhotoLibrary.requestAuthorizationForAccessLevelHandler(2, ignore);
      break;
    case "bluetooth":
      // Starting Bluetooth is what asks. Nil, as $(): a null queue crashed
      // it ("Cannot target object to cooperative root queue").
      ObjC.import("CoreBluetooth");
      $.CBCentralManager.alloc.initWithDelegateQueue($(), $());
      break;
    // These three add us to their list in System Settings (Accessibility and
    // Input monitoring as Miks Helper, Screen recording as Miks) and say so
    // in a dialog of their own, returning at once.
    case "accessibility":
      ObjC.import("ApplicationServices");
      $.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true }));
      return true;
    case "screen":
      ObjC.bindFunction("CGRequestScreenCaptureAccess", ["bool", []]);
      $.CGRequestScreenCaptureAccess();
      return true;
    case "input":
      ObjC.bindFunction("IOHIDRequestAccess", ["bool", ["unsigned int"]]);
      $.IOHIDRequestAccess(1);
      return true;
    case "systemEvents":
    case "finder":
    case "notes": {
      // Launching the app first, since asking needs it running. This one
      // waits for the answer itself.
      const bundleId = AUTOMATION_TARGETS[id];
      Application(bundleId).launch();
      ObjC.import("CoreServices");
      ObjC.bindFunction("AEDeterminePermissionToAutomateTarget", ["int", ["pointer", "unsigned int", "unsigned int", "bool"]]);
      const target = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier(bundleId);
      return $.AEDeterminePermissionToAutomateTarget(target.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, true) !== -1744;
    }
    default:
      throw new Error(`No way to ask for ${id}.`);
  }

  return wait(answered);
}

/** Runs the run loop (asking needs it) until `until`, or 2 minutes; whether it got there. */
function wait(until) {
  const deadline = Date.now() + 120_000;
  while (!until() && Date.now() < deadline) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1));
  }
  return until();
}
