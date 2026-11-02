import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "vitest";
import { syncGrokHooks } from "./grokHooks.ts";

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks-grok-hooks-"));
  fs.mkdirSync(path.join(dir, "bundle"));
  fs.writeFileSync(path.join(dir, "bundle/grok-hook.sh"), "#!/bin/sh\n");
  return {
    dir,
    options: {
      enabled: true,
      bundledScript: path.join(dir, "bundle/grok-hook.sh"),
      installedScript: path.join(dir, "Miks/grok-hook.sh"),
      grokHome: path.join(dir, "grok"),
    },
  };
};

test("does nothing where grok has never been", () => {
  const { dir, options } = setup();
  syncGrokHooks(options);
  expect(fs.existsSync(options.grokHome)).toBe(false);
  fs.rmSync(dir, { recursive: true });
});

test("a file of our own, beside others', gone when turned off", () => {
  const { dir, options } = setup();
  fs.mkdirSync(path.join(options.grokHome, "hooks"), { recursive: true });
  const theirs = path.join(options.grokHome, "hooks/cmux-session.json");
  fs.writeFileSync(theirs, "{}");
  const ours = path.join(options.grokHome, "hooks/miks.json");

  syncGrokHooks(options);
  const hooks = JSON.parse(fs.readFileSync(ours, "utf8")).hooks;
  expect(hooks.StopCancelled).toEqual([{ hooks: [{ type: "command", command: `'${options.installedScript}'` }] }]);
  expect(fs.existsSync(options.installedScript)).toBe(true);

  syncGrokHooks({ ...options, enabled: false });
  expect(fs.existsSync(ours)).toBe(false);
  expect(fs.readFileSync(theirs, "utf8")).toBe("{}");
  fs.rmSync(dir, { recursive: true });
});
