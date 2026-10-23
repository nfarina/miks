#!/usr/bin/env node
// @chatwing
// Minimal App Store Connect API client for release diagnostics and setup.
//
// The .p8 private key never touches disk in this repo — it's read from the macOS
// login keychain (item service "AppStoreConnect-API-Key"), base64-decoded, and
// used to sign a short-lived ES256 JWT.
//
// Usage:
//   ASC_ISSUER_ID=<issuer-uuid> node ios/asc-api.mjs [METHOD] "/v1/<endpoint>" ['<json body>']
// Examples:
//   ... node ios/asc-api.mjs "/v1/ciProducts?limit=50&include=app"
//   ... node ios/asc-api.mjs "/v1/apps?filter[bundleId]=com.nfarina.Hawthorne"
//   ... node ios/asc-api.mjs POST /v1/bundleIds '{"data":{...}}'
//
// GET is the default and the method may be omitted entirely, which keeps every
// existing read-only invocation working unchanged. Anything that isn't a GET
// prints what it is about to do and requires ASC_CONFIRM=yes in the
// environment — these endpoints mutate a shared Apple Developer account, where
// a typo is someone else's problem too.
//
// Key ID defaults to the keychain item's account; override with ASC_KEY_ID.
// Issuer ID has a baked-in default (it's a tenant ID, not a secret); override
// with ASC_ISSUER_ID. Source: App Store Connect → Users and Access →
// Integrations → App Store Connect API → Issuer ID.

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";

const KEYCHAIN_SERVICE = "AppStoreConnect-API-Key";
const ISSUER_ID = process.env.ASC_ISSUER_ID || "69a6de7b-b6c8-47e3-e053-5b8c7c11a4d1";

const METHODS = ["GET", "POST", "PATCH", "DELETE"];

// The method is optional, so the first argument is only a method if it looks
// like one — an endpoint always starts with "/".
const args = process.argv.slice(2);
const method = METHODS.includes((args[0] || "").toUpperCase())
  ? args.shift().toUpperCase()
  : "GET";
const [endpoint, body] = args;

if (!endpoint) {
  console.error('Usage: node ios/asc-api.mjs [METHOD] "/v1/<endpoint>" [\'<json body>\']');
  process.exit(2);
}

if (method !== "GET" && process.env.ASC_CONFIRM !== "yes") {
  console.error(`Refusing to ${method} ${endpoint} without ASC_CONFIRM=yes.`);
  console.error("This writes to the Apple Developer account shared by every app.");
  process.exit(2);
}

// The keychain item's account name is the API Key ID.
function keychainAccount() {
  if (process.env.ASC_KEY_ID) return process.env.ASC_KEY_ID;
  const meta = execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE], {
    encoding: "utf8",
  });
  const m = meta.match(/"acct"<blob>="([^"]+)"/);
  if (!m) throw new Error(`Could not find key ID for keychain service ${KEYCHAIN_SERVICE}`);
  return m[1];
}

function loadPrivateKey() {
  const b64 = execFileSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    { encoding: "utf8" },
  ).trim();
  return Buffer.from(b64, "base64").toString("utf8");
}

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function makeJWT(keyId, privateKey) {
  const header = { alg: "ES256", kid: keyId, typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: ISSUER_ID, iat: now, exp: now + 600, aud: "appstoreconnect-v1" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${sig.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_")}`;
}

const keyId = keychainAccount();
const token = makeJWT(keyId, loadPrivateKey());

if (method !== "GET") console.log(`${method} ${endpoint}`);

const res = await fetch(`https://api.appstoreconnect.apple.com${endpoint}`, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    ...(body ? { "Content-Type": "application/json" } : {}),
  },
  ...(body ? { body } : {}),
});
const text = await res.text();
console.log(`HTTP ${res.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
