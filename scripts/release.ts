// `yarn release <version> [--notes notes.md]`: builds Miks.app, notarizes it,
// and publishes it as GitHub release v<version>, with the two files every
// installed Miks updates from (packages/app/updates.ts):
//
// - Miks-macos.zip, the app (also the README's download link);
// - update.json, the feed, which Squirrel.Mac compares with its own version.
//
// Then commits the version bump and tags it, and deploys the web bundle the
// iOS app loads (`yarn deploy:web`). Without --notes it opens
// $EDITOR for release notes, which show in the update prompt.
//
// One-time setup: a Developer ID Application certificate in the keychain, and
// notarization credentials: `xcrun notarytool store-credentials miks-notary`
// (or NOTARY_PROFILE=<name> in .env.release.local).
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildApp, output, root, run } from "./build-app.ts";

const [version, ...rest] = process.argv.slice(2).map((arg) => arg.replace(/^v(?=\d)/, ""));
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("Usage: yarn release <version> [--notes notes.md]");
  process.exit(1);
}
const notesArg = rest[0] === "--notes" ? rest[1] : undefined;
const tag = `v${version}`;

loadEnv(path.join(root, ".env.release.local"));
const notaryProfile = process.env.NOTARY_PROFILE || "miks-notary";

// The repo the release goes to, from origin.
const repo = output("git", ["remote", "get-url", "origin"])
  .replace(/^(git@github\.com:|https:\/\/github\.com\/)/, "")
  .replace(/\.git$/, "");

if (output("git", ["status", "--porcelain"])) throw new Error("Commit or stash your changes first.");
if (spawnSync("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status === 0) {
  throw new Error(`${tag} is already tagged.`);
}

const notes = notesArg ? fs.readFileSync(notesArg, "utf8").trim() : editNotes();

//
// Build, with the version stamped in.
//

const appPackagePath = path.join(root, "packages/app/package.json");
const appPackage = JSON.parse(fs.readFileSync(appPackagePath, "utf8"));
appPackage.version = version;
fs.writeFileSync(appPackagePath, JSON.stringify(appPackage, null, 2) + "\n");

const builtApp = await buildApp();

//
// Notarize. The ticket is stapled into the app, then the app zipped again,
// so it opens without a network check.
//

const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });
const zipPath = path.join(dist, "Miks-macos.zip");
const zip = () => {
  fs.rmSync(zipPath, { force: true });
  // ditto, not zip: it keeps the bundle's symlinks and metadata intact.
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", builtApp, zipPath]);
};

zip();
console.log(`Notarizing (profile ${notaryProfile})…`);
const submission = JSON.parse(
  output("xcrun", ["notarytool", "submit", zipPath, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"]),
);
if (submission.status !== "Accepted") {
  spawnSync("xcrun", ["notarytool", "log", submission.id, "--keychain-profile", notaryProfile], { stdio: "inherit" });
  throw new Error(`Notarization failed: ${submission.status}.`);
}
run("xcrun", ["stapler", "staple", builtApp]);
zip();

//
// The feed.
//

const updatePath = path.join(dist, "update.json");
const release = {
  version,
  updateTo: {
    version,
    name: version,
    notes,
    pub_date: new Date().toISOString(),
    url: `https://github.com/${repo}/releases/download/${tag}/Miks-macos.zip`,
  },
};
fs.writeFileSync(updatePath, JSON.stringify({ currentRelease: version, releases: [release] }, null, 2) + "\n");

//
// Publish.
//

// Already at this version (a first release, or a retry), there's no bump.
if (output("git", ["status", "--porcelain", appPackagePath])) run("git", ["commit", "-m", `Release ${tag}`, appPackagePath]);
run("git", ["tag", tag]);
run("git", ["push", "origin", "HEAD", tag]);

const notesFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "miks-release-")), "notes.md");
fs.writeFileSync(notesFile, notes + "\n");
run("gh", ["release", "create", tag, zipPath, updatePath, "--repo", repo, "--title", tag, "--notes-file", notesFile]);

// The iOS app's UI is the web bundle, not the release: without this, it
// kept the last one deployed, fixes and all missing.
run("node", ["scripts/deploy-web.ts"]);

console.log(`\nPublished ${tag}: https://github.com/${repo}/releases/tag/${tag}`);

//
// Helpers.
//

/** Release notes from $EDITOR, as `git commit` does it; empty cancels. */
function editNotes(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "miks-notes-")), `${tag}.md`);
  fs.writeFileSync(
    file,
    "\n\n<!-- Release notes for Miks " + tag + ", in Markdown. Empty cancels the release. -->\n",
  );
  const editor = process.env.VISUAL || process.env.EDITOR || "vi";
  // $EDITOR may carry flags ("code --wait"), so the shell splits it.
  spawnSync("sh", ["-c", `${editor} "$1"`, "sh", file], { stdio: "inherit" });

  const notes = fs.readFileSync(file, "utf8").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!notes) {
    console.error("No release notes; cancelled.");
    process.exit(1);
  }
  return notes;
}

/** KEY=value lines, without overriding the environment. */
function loadEnv(file: string) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && !(match[1] in process.env)) process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
}
