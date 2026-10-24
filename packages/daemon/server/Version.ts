import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { PROTOCOL_VERSION } from "../shared/protocol.ts";

/** Where the daemon runs from: the repo, or Miks.app's Resources/app. */
const ROOT = path.resolve(import.meta.dirname, "../../..");

type Build = { version: string; commit: string | null; built: string | null };

/**
 * Which Miks this is: Miks.app's build.json (scripts/build-app.ts), or in
 * the repo its version and the commit checked out ("+changes" with work not
 * committed yet).
 */
function readBuild(): Build {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "build.json"), "utf8"));
  } catch {}
  let version = "?";
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/app/package.json"), "utf8")).version;
  } catch {}
  let commit: string | null = null;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 2000 }).trim();
    commit = git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain", "--untracked-files=no") ? "+changes" : "");
  } catch {}
  return { version, commit, built: null };
}

const running = readBuild();
const started = new Date();

const describe = ({ version, commit, built }: Build) =>
  `Miks ${version}${commit ? ` (${commit}${built ? `, built ${new Date(built).toLocaleString()}` : ""})` : ""}`;

/**
 * For `miks version`: the Miks this daemon runs, since when, and whether
 * what's there now is another one (Miks.app updated, or new commits in the
 * repo), which it runs only once restarted.
 */
export function versionReport(): string {
  const lines = [describe(running), `Protocol ${PROTOCOL_VERSION}, daemon pid ${process.pid}, up since ${started.toLocaleString()}`];
  const now = readBuild();
  if (now.version !== running.version || now.commit !== running.commit) {
    lines.push(`Installed now: ${describe(now)}. Restart the daemon to run it (Miks → Restart daemon…).`);
  }
  return `${lines.join("\n")}\n`;
}
