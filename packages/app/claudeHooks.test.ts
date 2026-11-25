import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { hookCommand, syncClaudeHooks } from "./claudeHooks.ts";

let dir: string;
let paths: { bundledScript: string; installedScript: string; claudeSettingsPath: string };

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks hooks-"));
  paths = {
    bundledScript: path.join(dir, "bundle/claude-hook.sh"),
    installedScript: path.join(dir, "Miks/claude-hook.sh"),
    claudeSettingsPath: path.join(dir, ".claude/settings.json"),
  };
  fs.mkdirSync(path.dirname(paths.bundledScript));
  fs.writeFileSync(paths.bundledScript, "#!/bin/sh\nexit 0\n");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const read = () => JSON.parse(fs.readFileSync(paths.claudeSettingsPath, "utf8"));
const write = (settings: any) => {
  fs.mkdirSync(path.dirname(paths.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsPath, JSON.stringify(settings));
};

test("installs the script and a hook for each event, keeping the rest of the settings", () => {
  const theirs = { hooks: [{ type: "command", command: "say done" }] };
  write({ model: "opus", hooks: { Stop: [theirs] } });

  syncClaudeHooks({ enabled: true, ...paths });

  const settings = read();
  expect(settings.model).toBe("opus");
  expect(settings.hooks.Stop).toEqual([theirs, { hooks: [{ type: "command", command: hookCommand(paths.installedScript) }] }]);
  expect(settings.hooks.SessionStart).toHaveLength(1);
  // Questions, waited on for as long as they take.
  expect(settings.hooks.PermissionRequest).toEqual([
    { matcher: "AskUserQuestion", hooks: [{ type: "command", command: hookCommand(paths.installedScript), timeout: 86400 }] },
  ]);
  expect(fs.statSync(paths.installedScript).mode & 0o111).toBeTruthy();

  // Again changes nothing.
  // A shell runs the command as written, path with a space and all.
  expect(execSync(`${hookCommand(paths.installedScript)}; echo ran`, { encoding: "utf8" })).toBe("ran\n");

  const before = fs.readFileSync(paths.claudeSettingsPath, "utf8");
  syncClaudeHooks({ enabled: true, ...paths });
  expect(fs.readFileSync(paths.claudeSettingsPath, "utf8")).toBe(before);
});

test("replaces hooks pointing at an older copy, and removes them all when turned off", () => {
  const old = { hooks: [{ type: "command", command: "/Users/x/Code/miks/packages/daemon/hooks/claude-hook.sh" }] };
  write({ hooks: { Stop: [old], PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] } });

  syncClaudeHooks({ enabled: true, ...paths });
  expect(read().hooks.Stop).toEqual([{ hooks: [{ type: "command", command: hookCommand(paths.installedScript) }] }]);

  syncClaudeHooks({ enabled: false, ...paths });
  expect(read().hooks).toEqual({ PreToolUse: [{ hooks: [{ type: "command", command: "lint" }] }] });
});

test("leaves settings it can't parse alone", () => {
  fs.mkdirSync(path.dirname(paths.claudeSettingsPath), { recursive: true });
  fs.writeFileSync(paths.claudeSettingsPath, "{ not json");
  syncClaudeHooks({ enabled: true, ...paths });
  expect(fs.readFileSync(paths.claudeSettingsPath, "utf8")).toBe("{ not json");
});
