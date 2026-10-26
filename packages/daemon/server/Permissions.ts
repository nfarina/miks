import { execFile } from "child_process";
import dgram from "dgram";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import type { Permission, PermissionStatus } from "../shared/protocol.ts";

// What macOS lets the programs in our terminals do. They all count as the
// daemon, a launchd job of its own, so as the helper it runs on (Miks
// Helper), and each permission is asked for the first time a program needs
// it: in a dialog on this Mac's screen, which nobody may be at. Asking ahead
// of time, from Settings, is what this is for.

const run = promisify(execFile);
const script = path.join(import.meta.dirname, "permissions.js");

type Definition = Omit<Permission, "status" | "asking"> & {
  /** System Settings' Privacy & Security pane for it. */
  pane: string;
};

const DEFINITIONS: Definition[] = [
  { id: "localNetwork", name: "Local network", detail: "ssh, ping and the like, to other machines here.", kind: "ask", pane: "LocalNetwork" },
  { id: "fullDisk", name: "Full Disk Access", detail: "Every file, including other apps' data. Covers the folders below.", kind: "settings", pane: "AllFiles" },
  { id: "desktop", name: "Desktop folder", detail: "", kind: "ask", pane: "FilesAndFolders" },
  { id: "documents", name: "Documents folder", detail: "", kind: "ask", pane: "FilesAndFolders" },
  { id: "downloads", name: "Downloads folder", detail: "", kind: "ask", pane: "FilesAndFolders" },
  { id: "accessibility", name: "Accessibility", detail: "Controlling other apps' windows and keys.", kind: "settings", pane: "Accessibility" },
  { id: "screen", name: "Screen recording", detail: "Screenshots, as from screencapture.", kind: "settings", pane: "ScreenCapture" },
  { id: "input", name: "Input monitoring", detail: "Seeing keys typed into other apps.", kind: "settings", pane: "ListenEvent" },
  { id: "developerTools", name: "Developer tools", detail: "Running what they build without macOS checking it first, which is faster.", kind: "settings", pane: "DevTools" },
  { id: "appManagement", name: "App management", detail: "Updating or deleting other apps.", kind: "settings", pane: "AppBundles" },
  { id: "systemEvents", name: "Automation: System Events", detail: "AppleScript that drives the system UI.", kind: "ask", pane: "Automation" },
  { id: "finder", name: "Automation: Finder", detail: "AppleScript that drives the Finder.", kind: "ask", pane: "Automation" },
  { id: "notes", name: "Automation: Notes", detail: "AppleScript that reads and writes your notes.", kind: "ask", pane: "Automation" },
  { id: "camera", name: "Camera", detail: "", kind: "ask", pane: "Camera" },
  { id: "microphone", name: "Microphone", detail: "Voice input, as in Claude Code's.", kind: "ask", pane: "Microphone" },
  { id: "contacts", name: "Contacts", detail: "", kind: "ask", pane: "Contacts" },
  { id: "calendars", name: "Calendars", detail: "", kind: "ask", pane: "Calendars" },
  { id: "reminders", name: "Reminders", detail: "", kind: "ask", pane: "Reminders" },
  { id: "photos", name: "Photos", detail: "", kind: "ask", pane: "Photos" },
  { id: "bluetooth", name: "Bluetooth", detail: "", kind: "ask", pane: "Bluetooth" },
];

/** The folders behind the Files and Folders permissions, which reading asks for. */
const FOLDERS: Record<string, string> = {
  desktop: "Desktop",
  documents: "Documents",
  downloads: "Downloads",
};

/** The helper's own bundle, which is who macOS takes us for; none when run on plain Node. */
const bundle = path.resolve(process.execPath, "../../Info.plist");

/**
 * The app the helper is inside (Miks.app). Most permissions go to it, not
 * the helper (tccd's AUTHREQ_SUBJECT): all but Accessibility and Input
 * monitoring, which list the helper itself.
 */
const app = bundle.match(/^(.*?\.app)\/Contents\/Frameworks\//)?.[1];

async function bundleValue(key: string, plist = bundle): Promise<string | null> {
  try {
    return (await run("plutil", ["-extract", key, "raw", plist])).stdout.trim();
  } catch {
    return null;
  }
}

/** What macOS calls us in its dialogs and in System Settings ("Miks"). */
export async function permissionsApp(): Promise<string | null> {
  return app ? bundleValue("CFBundleName", path.join(app, "Contents/Info.plist")) : null;
}

const asking = new Set<string>();
let queue: Promise<void> = Promise.resolve();

export async function checkPermissions(): Promise<Permission[]> {
  let statuses: Record<string, PermissionStatus> = {};
  try {
    statuses = JSON.parse((await run("osascript", ["-l", "JavaScript", script, "status"])).stdout);
  } catch {}
  statuses.localNetwork = await localNetworkStatus();
  // Full Disk Access covers the folders, and with it reading them never
  // asks, so they'd stay "not asked" for good.
  if (statuses.fullDisk === "granted") for (const id of Object.keys(FOLDERS)) statuses[id] = "granted";

  return DEFINITIONS.map(({ pane: _pane, ...definition }) => ({
    ...definition,
    status: statuses[definition.id] ?? "unknown",
    asking: asking.has(definition.id),
  }));
}

/**
 * Asks macOS for one, or, for what only a switch in System Settings grants
 * (or was turned down before), opens that switch's pane, with Miks shown
 * in the Finder to drag in where the list needs adding to. One at a
 * time; `onChange` hears when it's asking and when it's answered.
 */
export function requestPermission(id: string, onChange: () => void): Promise<void> {
  const definition = DEFINITIONS.find((item) => item.id === id);
  if (!definition || asking.has(id)) return Promise.resolve();

  asking.add(id);
  onChange();
  const request = async () => {
    try {
      const [current] = (await checkPermissions()).filter((item) => item.id === id);
      if (current?.status === "granted") return;
      if (definition.kind === "settings" || current?.status === "denied") {
        // Asking is what puts us in these lists (switched off), so there's
        // a switch to turn on.
        if (LISTS_ITSELF.includes(id)) await run("osascript", ["-l", "JavaScript", script, "request", id]).catch(() => {});
        await openSettings(definition);
        return;
      }
      if (id === "localNetwork") return await askLocalNetwork();
      if (FOLDERS[id]) {
        await fs.promises.readdir(path.join(os.homedir(), FOLDERS[id])).catch(() => {});
        return;
      }
      await run("osascript", ["-l", "JavaScript", script, "request", id], { timeout: 150_000 }).catch(() => {});
    } finally {
      asking.delete(id);
      onChange();
    }
  };
  queue = queue.then(request);
  return queue;
}

/** The ones whose list in System Settings asking adds us to. */
const LISTS_ITSELF = ["accessibility", "screen", "input"];

/** The ones System Settings lists under the helper, not the app (see `app`). */
const AS_HELPER = ["accessibility", "input"];

async function openSettings(definition: Definition) {
  await run("open", [`x-apple.systempreferences:com.apple.preference.security?Privacy_${definition.pane}`]);
  // And what to drag in, should we not be in its list: the helper or the
  // app, whichever it goes by. A helper dragged in where the app was wanted
  // turned on and still counted for nothing. (The rest take no drags.)
  if (definition.kind !== "settings") return;
  const bundleDir = AS_HELPER.includes(definition.id) ? path.dirname(path.dirname(bundle)) : app;
  if (bundleDir && fs.existsSync(bundleDir)) await run("open", ["-R", bundleDir]);
}

/**
 * Sending anything to the local network asks, the first time: an mDNS query
 * does, from this process, which is who's asking.
 */
async function askLocalNetwork() {
  const socket = dgram.createSocket("udp4");
  // A query for nothing in particular ("_miks._tcp.local", type PTR).
  const name = Buffer.concat(
    ["_miks", "_tcp", "local"].map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
  );
  const query = Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]),
    name,
    Buffer.from([0, 0, 12, 0, 1]),
  ]);
  await new Promise<void>((resolve) => {
    socket.on("error", () => resolve());
    socket.send(query, 5353, "224.0.0.251", () => resolve());
  });
  socket.close();
  // The answer lands in its rules (below) once you've given it.
  for (let i = 0; i < 1200 && (await localNetworkStatus()) === "notAsked"; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Local Network has no way to ask how it stands. Its rules are in a
 * keyed archive anyone can read, so this finds ours in `plutil -p`'s
 * printout: the rule whose SigningIdentifier is our bundle ID, with
 * DenyMulticast for no and MulticastPreferenceSet once you've answered.
 */
async function localNetworkStatus(): Promise<PermissionStatus> {
  const id = await bundleValue("CFBundleIdentifier");
  if (!id) return "unknown";
  let printout: string;
  try {
    printout = (await run("plutil", ["-p", "/Library/Preferences/com.apple.networkextension.plist"], { maxBuffer: 16 << 20 }))
      .stdout;
  } catch {
    return "unknown";
  }

  // Top-level objects are indented four spaces: `    12 => "com.example"`,
  // or `    13 => {` and its keys until the next.
  const strings = new Map<string, string>();
  const rules: { identifier?: string; deny?: boolean; set?: boolean }[] = [];
  let rule: (typeof rules)[number] | null = null;
  for (const line of printout.split("\n")) {
    const top = line.match(/^ {4}(\d+) => (.*)$/);
    if (top) {
      rule = null;
      if (top[2].startsWith('"')) strings.set(top[1], top[2].slice(1, -1));
      else if (top[2] === "{") rules.push((rule = {}));
      continue;
    }
    if (!rule) continue;
    const field = line.match(/^ {6}"(\w+)" => (.*)$/);
    if (!field) continue;
    if (field[1] === "SigningIdentifier") rule.identifier = field[2].match(/value = (\d+)/)?.[1];
    if (field[1] === "DenyMulticast") rule.deny = field[2] === "true";
    if (field[1] === "MulticastPreferenceSet") rule.set = field[2] === "true";
  }

  const ours = rules.filter((item) => item.identifier && strings.get(item.identifier) === id && item.set);
  if (ours.length === 0) return "notAsked";
  return ours.some((item) => !item.deny) ? "granted" : "denied";
}
