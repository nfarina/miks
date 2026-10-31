// ripgrep for the daemon's Find in files and ⌘P, downloaded rather than taken
// from PATH: Homebrew's links to its own PCRE2, and a Mac needn't have it.
import { execFileSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

const VERSION = "15.2.0";
const NAME = `ripgrep-${VERSION}-aarch64-apple-darwin`;
const SHA256 = "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4";

/** Where it goes (ignored, as `build/` is), and where `server/Search.ts` looks. */
export const RIPGREP = path.resolve(import.meta.dirname, "../packages/daemon/ripgrep/build/rg");

export function fetchRipgrep() {
  if (fs.existsSync(RIPGREP)) return;
  console.log(`Downloading ripgrep ${VERSION}…`);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "miks-ripgrep-"));
  const archive = path.join(folder, "rg.tar.gz");
  execFileSync("curl", ["-fsSL", "-o", archive, `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${NAME}.tar.gz`], {
    stdio: "inherit",
  });
  const sum = crypto.createHash("sha256").update(fs.readFileSync(archive)).digest("hex");
  if (sum !== SHA256) throw new Error(`ripgrep's download has the wrong checksum: ${sum}`);
  execFileSync("tar", ["-xzf", archive, "-C", folder, `${NAME}/rg`]);
  fs.mkdirSync(path.dirname(RIPGREP), { recursive: true });
  fs.renameSync(path.join(folder, NAME, "rg"), RIPGREP);
  fs.rmSync(folder, { recursive: true, force: true });
}

if (import.meta.main) fetchRipgrep();
