// Builds Miks.app, signed with the Developer ID in the keychain (as Brushy
// is), into build/Miks-darwin-arm64. Used by `yarn install:app` and
// `yarn release`.
import { packager } from "@electron/packager";
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

export const root = path.resolve(import.meta.dirname, "..");
export const bundleId = "com.nfarina.miks";
const buildDir = path.join(root, "build");
const stage = path.join(buildDir, "stage");

export const run = (command: string, args: string[], options: { cwd?: string } = {}) =>
  execFileSync(command, args, { stdio: "inherit", cwd: options.cwd ?? root });
export const output = (command: string, args: string[]) => execFileSync(command, args, { encoding: "utf8" }).trim();

/** Returns the built app's path. */
export async function buildApp(): Promise<string> {
  //
  // Sign with the Developer ID, as Brushy does.
  //

  const identity =
    process.env.APPLE_SIGNING_IDENTITY ||
    output("security", ["find-identity", "-v", "-p", "codesigning"]).match(/"(Developer ID Application: [^"]+)"/)?.[1];
  if (!identity) throw new Error("No Developer ID Application identity in the keychain.");
  console.log(`Signing identity: ${identity}`);

  //
  // Stage the app: the same layout as the repo, with only what runs.
  //

  console.log("Building the UI…");
  run("yarn", ["workspace", "ui", "build"]);

  fs.rmSync(stage, { recursive: true, force: true });
  const copy = (from: string, to = from) =>
    fs.cpSync(path.join(root, from), path.join(stage, to), {
      recursive: true,
      verbatimSymlinks: true,
      filter: (file) => !file.endsWith(".test.ts"),
    });

  // Every module of the main process (a new one left out once meant a Miks
  // that couldn't start), but not the dev launcher.
  for (const file of fs.readdirSync(path.join(root, "packages/app"))) {
    if (file.endsWith(".ts") && !file.endsWith(".test.ts") && file !== "dev.ts") copy(`packages/app/${file}`);
  }
  copy("packages/daemon/hooks");
  copy("packages/daemon/shell");
  copy("packages/app/preload.cjs");
  copy("packages/app/icon/icon.png");
  copy("packages/daemon/package.json");
  copy("packages/daemon/server");
  copy("packages/daemon/shared");
  // The keeper ("Awake, unlocked"), built here: the daemon builds it from
  // source in the repo, and the bundle has only the binary (server/Keeper.ts).
  console.log("Building the keeper…");
  fs.mkdirSync(path.join(stage, "packages/daemon/keeper/build"), { recursive: true });
  run("swiftc", ["-O", path.join(root, "packages/daemon/keeper/Keeper.swift"), "-o", path.join(stage, "packages/daemon/keeper/build/miks-keeper")]);
  copy("packages/ui/dist");
  for (const name of ["node-pty", "ws", "@xterm/headless", "@xterm/addon-serialize"]) {
    copy(`node_modules/${name}`);
  }
  // The app imports the daemon's shared code as the `miks` package. In the repo
  // that's Yarn's symlink to packages/daemon; here it's a stub package that
  // re-exports from there, because Node won't run TypeScript from inside
  // node_modules, and the packager rewrites symlinks to absolute paths, which
  // codesign rightly rejects.
  const stub = path.join(stage, "node_modules/miks");
  fs.mkdirSync(path.join(stub, "shared"), { recursive: true });
  fs.writeFileSync(
    path.join(stub, "package.json"),
    JSON.stringify({ name: "miks", type: "module", exports: { "./shared/*": "./shared/*.js" } }),
  );
  for (const file of fs.readdirSync(path.join(root, "packages/daemon/shared"))) {
    const name = path.basename(file, ".ts");
    fs.writeFileSync(path.join(stub, `shared/${name}.js`), `export * from "../../../packages/daemon/shared/${file}";\n`);
  }

  const appPackage = JSON.parse(fs.readFileSync(path.join(root, "packages/app/package.json"), "utf8"));
  // Which Miks this is, for `miks version` (server/Version.ts): the commit,
  // "+changes" with work not committed yet.
  const git = (...args: string[]) => output("git", ["-C", root, ...args]);
  fs.writeFileSync(
    path.join(stage, "build.json"),
    JSON.stringify({
      version: appPackage.version,
      commit: git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain", "--untracked-files=no") ? "+changes" : ""),
      built: new Date().toISOString(),
    }),
  );
  fs.writeFileSync(
    path.join(stage, "package.json"),
    JSON.stringify(
      {
        name: "miks",
        productName: "Miks",
        version: appPackage.version,
        type: "module",
        main: "packages/app/main.ts",
      },
      null,
      2,
    ),
  );

  //
  // Package and sign.
  //

  const electronVersion = JSON.parse(fs.readFileSync(path.join(root, "node_modules/electron/package.json"), "utf8")).version;
  const usage = (what: string) => `A program running in Miks wants to use ${what}.`;

  console.log(`Packaging with Electron ${electronVersion}…`);
  // Why a program in a terminal wants each thing macOS asks about.
  const usageDescriptions = {
    NSAppleEventsUsageDescription: usage("other apps through AppleScript"),
    NSBluetoothAlwaysUsageDescription: usage("Bluetooth"),
    NSCalendarsFullAccessUsageDescription: usage("your calendars"),
    NSCalendarsUsageDescription: usage("your calendars"),
    NSCameraUsageDescription: usage("the camera"),
    NSContactsUsageDescription: usage("your contacts"),
    NSLocationUsageDescription: usage("your location"),
    // Without it macOS never asks, and connections from terminals to other
    // machines on your network fail at random ("Undefined error: 0" from
    // ssh), though the internet, and anything over a VPN, work.
    NSLocalNetworkUsageDescription: usage("devices on your local network"),
    NSMicrophoneUsageDescription: usage("the microphone"),
    NSPhotoLibraryUsageDescription: usage("your photos"),
    NSRemindersFullAccessUsageDescription: usage("your reminders"),
    NSRemindersUsageDescription: usage("your reminders"),
  };

  const [appDir] = await packager({
    dir: stage,
    out: buildDir,
    name: "Miks",
    platform: "darwin",
    arch: "arm64",
    electronVersion,
    overwrite: true,
    // Plain files: the daemon and main process run TypeScript from source, and
    // node-pty's binaries must sit on disk to be signed and loaded.
    asar: false,
    prune: false,
    derefSymlinks: false,
    icon: path.join(root, "packages/app/icon/Miks.icns"),
    appBundleId: bundleId,
    appCategoryType: "public.app-category.developer-tools",
    darwinDarkModeSupport: true,
    extendInfo: {
      // Folders, so one dropped on the Dock icon, or `open -a Miks <folder>`
      // (GitHub Desktop's custom shell), opens a workspace there. Rank
      // None: Miks is never what opens a folder by default.
      CFBundleDocumentTypes: [
        { CFBundleTypeName: "Folder", CFBundleTypeRole: "Viewer", LSHandlerRank: "None", LSItemContentTypes: ["public.folder"] },
      ],
      // miks://update, which `miks update` opens.
      CFBundleURLTypes: [{ CFBundleURLName: "com.nfarina.miks", CFBundleURLSchemes: ["miks"] }],
      ...usageDescriptions,
    },
    afterCopy: [({ buildPath }) => giveOwnUUIDs(path.resolve(buildPath, "../.."))],
    // The daemon runs on the plain helper, as its own process (startDaemon in
    // main.ts), so macOS asks for its terminals' permissions as Miks Helper.
    extendHelperInfo: usageDescriptions,
    osxSign: {
      identity,
      continueOnError: false,
      optionsForFile: (file) =>
        // Miks's entitlements for the app and the helper the daemon runs on
        // (under the hardened runtime, no entitlement means no access); the
        // other helpers keep the defaults.
        /\/(Miks|Miks Helper)\.app$|\/Contents\/MacOS\/(Miks|Miks Helper)$/.test(file)
          ? { hardenedRuntime: true, entitlements: path.join(root, "packages/app/entitlements.plist") }
          : { hardenedRuntime: true },
    },
  });

  const builtApp = path.join(appDir, "Miks.app");
  run("codesign", ["--verify", "--deep", "--strict", builtApp]);
  console.log(`Built and verified ${path.relative(root, builtApp)}.`);
  return builtApp;
}

/**
 * Gives the app's executables Mach-O UUIDs of their own. Electron's are the
 * same in every Electron app, and Local Network finds a process's bundle by
 * its UUID (in LaunchServices), so the daemon was sometimes taken for the
 * repo's Electron Helper, and asked as that. Derived from the bundle ID, so
 * a build keeps them until Electron changes.
 */
function giveOwnUUIDs(contents: string) {
  const executables = [
    ...fs.readdirSync(path.join(contents, "MacOS")).map((name) => path.join(contents, "MacOS", name)),
    ...fs
      .readdirSync(path.join(contents, "Frameworks"))
      .filter((name) => name.endsWith(".app"))
      .flatMap((app) => {
        const dir = path.join(contents, "Frameworks", app, "Contents/MacOS");
        return fs.readdirSync(dir).map((name) => path.join(dir, name));
      }),
  ];
  for (const file of executables) {
    const binary = fs.readFileSync(file);
    // A thin 64-bit Mach-O (arm64 only): its load commands follow the
    // 32-byte header, and LC_UUID (0x1b) holds 16 bytes after its own 8.
    if (binary.readUInt32LE(0) !== 0xfeedfacf) throw new Error(`Not a thin 64-bit Mach-O: ${file}`);
    let offset = 32;
    let found = false;
    for (let i = 0; i < binary.readUInt32LE(16); i++) {
      const command = binary.readUInt32LE(offset);
      if (command === 0x1b) {
        const old = binary.subarray(offset + 8, offset + 24);
        const uuid = crypto.createHash("sha256").update(bundleId).update(old).digest().subarray(0, 16);
        uuid[6] = (uuid[6] & 0x0f) | 0x40;
        uuid[8] = (uuid[8] & 0x3f) | 0x80;
        uuid.copy(binary, offset + 8);
        found = true;
      }
      offset += binary.readUInt32LE(offset + 4);
    }
    if (!found) throw new Error(`No LC_UUID in ${file}`);
    fs.writeFileSync(file, binary);
  }
}
