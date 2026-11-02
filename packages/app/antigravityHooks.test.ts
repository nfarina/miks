import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { syncAntigravityHooks } from "./antigravityHooks.ts";

let dir: string;
let options: Parameters<typeof syncAntigravityHooks>[0];
const file = () => path.join(options.geminiHome, "config/hooks.json");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks-agy-hooks-"));
  fs.writeFileSync(path.join(dir, "hook.sh"), "#!/bin/sh\n");
  options = {
    enabled: true,
    bundledScript: path.join(dir, "hook.sh"),
    installedScript: path.join(dir, "Miks Home/antigravity-hook.sh"),
    geminiHome: path.join(dir, "gemini"),
  };
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("does nothing where Antigravity has never been", () => {
  syncAntigravityHooks(options);
  expect(fs.existsSync(options.geminiHome)).toBe(false);
});

test("adds ours beside others' named hooks, and turning off takes only ours", () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  const theirs = { lint: { PostToolUse: [{ matcher: "*", hooks: [{ command: "lint" }] }] } };
  fs.writeFileSync(file(), JSON.stringify(theirs));

  syncAntigravityHooks(options);
  const hooks = JSON.parse(fs.readFileSync(file(), "utf8"));
  expect(hooks.lint).toEqual(theirs.lint);
  expect(Object.keys(hooks.miks)).toEqual(["SessionStart", "PreInvocation", "PostToolUse", "Stop"]);
  expect(hooks.miks.Stop[0].command).toBe(`'${options.installedScript}'`);
  expect(fs.statSync(options.installedScript).mode & 0o111).toBeTruthy();

  syncAntigravityHooks({ ...options, enabled: false });
  expect(JSON.parse(fs.readFileSync(file(), "utf8"))).toEqual(theirs);
});

test("an empty file is fine, and one that isn't JSON is left alone", () => {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), "");
  syncAntigravityHooks(options);
  expect(JSON.parse(fs.readFileSync(file(), "utf8")).miks).toBeTruthy();

  fs.writeFileSync(file(), "{ nope");
  syncAntigravityHooks(options);
  expect(fs.readFileSync(file(), "utf8")).toBe("{ nope");
});
