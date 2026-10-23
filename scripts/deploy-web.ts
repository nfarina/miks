// `yarn deploy:web [--dry-run]`: builds the UI as the bundle the iOS app
// downloads (ios/Shared/WebBundle.swift) and deploys it to Cloudflare, at
// https://miks-app.nfarina.com (web/wrangler.jsonc). At the root:
//
// - bundle.json, `{ hash, created }`: the app downloads again when the hash changes;
// - bundle.zip, with one dist/ folder, the UI and its own bundle.json;
// - bundle.zip.size, its length in bytes, as text (the app's progress bar);
// - and the UI itself, for loading live (Settings → Miks → no cached bundle).
//
// The terminals are a Mac's: the page connects to one over Tailscale.
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const root = path.resolve(import.meta.dirname, "..");
const dryRun = process.argv.includes("--dry-run");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "miks-web-"));
const dist = path.join(work, "dist");
const publicDir = path.join(root, "web/public");

const run = (command: string, args: string[], cwd = root) => execFileSync(command, args, { cwd, stdio: "inherit" });

run("npx", ["vite", "build", "--outDir", dist, "--emptyOutDir"], path.join(root, "packages/ui"));

// Vite names the entry after its content, so that's the bundle's hash.
const entry = fs.readdirSync(path.join(dist, "assets")).find((file) => /^index-.+\.js$/.test(file));
if (!entry) throw new Error("No index-*.js in the build.");
const bundle = { hash: entry.replace(/^index-|\.js$/g, ""), created: Date.now() };
fs.writeFileSync(path.join(dist, "bundle.json"), JSON.stringify(bundle));

// Without source maps: the app never shows them.
run("zip", ["-qrX", "bundle.zip", "dist", "-x", "*.map"], work);
const zipSize = fs.statSync(path.join(work, "bundle.zip")).size;

fs.rmSync(publicDir, { recursive: true, force: true });
fs.cpSync(dist, publicDir, { recursive: true });
fs.copyFileSync(path.join(work, "bundle.zip"), path.join(publicDir, "bundle.zip"));
fs.writeFileSync(path.join(publicDir, "bundle.zip.size"), String(zipSize));
fs.rmSync(work, { recursive: true, force: true });
console.log(`Bundle ${bundle.hash}: ${(zipSize / 1e6).toFixed(1)} MB zipped, in web/public.`);

if (!dryRun) run("wrangler", ["deploy"], path.join(root, "web"));
