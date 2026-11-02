import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "vitest";
import { syncCodexHooks, untrustedHooks } from "./codexHooks.ts";

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks-codex-hooks-"));
  fs.mkdirSync(path.join(dir, "bundle"));
  fs.writeFileSync(path.join(dir, "bundle/codex-hook.sh"), "#!/bin/sh\n");
  return {
    dir,
    options: {
      enabled: false,
      bundledScript: path.join(dir, "bundle/codex-hook.sh"),
      installedScript: path.join(dir, "Miks/codex-hook.sh"),
      codexHome: path.join(dir, "codex"),
    },
  };
};

test("does nothing where Codex has never been", async () => {
  const { dir, options } = setup();
  await syncCodexHooks({ ...options, enabled: true });
  expect(fs.existsSync(options.codexHome)).toBe(false);
  expect(fs.existsSync(options.installedScript)).toBe(false);
  fs.rmSync(dir, { recursive: true });
});

test("turning them off removes ours and leaves everything else", async () => {
  const { dir, options } = setup();
  fs.mkdirSync(options.codexHome);
  const file = path.join(options.codexHome, "hooks.json");
  const theirs = { hooks: [{ type: "command", command: "/usr/local/bin/lint" }] };
  const ours = { hooks: [{ type: "command", command: `'${options.installedScript}'` }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [theirs, ours], SessionEnd: [ours] }, other: 1 }));

  await syncCodexHooks(options);

  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ hooks: { Stop: [theirs] }, other: 1 });
  fs.rmSync(dir, { recursive: true });
});

test("only our own hooks are ever trusted", () => {
  const hook = (fields: object) => ({ key: "k", currentHash: "h", source: "user", command: "ours", trustStatus: "untrusted", ...fields });
  const entries = [
    {
      hooks: [
        hook({ key: "new" }),
        hook({ key: "changed", trustStatus: "modified" }),
        hook({ key: "fine", trustStatus: "trusted" }),
        hook({ key: "someone else's", command: "theirs" }),
        hook({ key: "a project's", source: "project" }),
      ],
    },
  ];
  expect(untrustedHooks(entries, "ours").map((each) => each.key)).toEqual(["new", "changed"]);
});
