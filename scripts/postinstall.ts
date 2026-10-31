// Third-party install scripts are disabled globally (enableScripts: false),
// so this does the two that Miks actually needs, by hand.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fetchRipgrep } from "./ripgrep.ts";

const root = path.resolve(import.meta.dirname, "..");

// node-pty's prebuilt spawn-helper ships without its executable bit, which
// its postinstall would otherwise fix; without it every spawn fails with
// "posix_spawnp failed".
const prebuilds = path.join(root, "node_modules/node-pty/prebuilds");
for (const platform of fs.readdirSync(prebuilds)) {
  const helper = path.join(prebuilds, platform, "spawn-helper");
  if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
}

// Electron's package is a stub until its install script downloads the binary.
const electron = path.join(root, "node_modules/electron");
if (!fs.existsSync(path.join(electron, "path.txt"))) {
  execFileSync(process.execPath, [path.join(electron, "install.js")], { stdio: "inherit" });
}

fetchRipgrep();
