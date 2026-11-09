import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findPaths, writeFromPanel } from "./Files.ts";

let repo: string;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miks paths-")));
  fs.mkdirSync(path.join(repo, ".git"));
  for (const file of ["packages/ui/codeMenu.tsx", "packages/ui/index.ts", "packages/daemon/index.ts", "sell-stuff/notes.md"]) {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), "");
  }
});

afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

test("a code span's path is found in the repo by how it ends, when it isn't where the shell is", async () => {
  const find = (written: string, cwd = repo) => findPaths([written], cwd, { search: true }).then(([found]) => found);
  const ui = path.join(repo, "packages/ui");

  expect(await find("codeMenu.tsx")).toEqual({ path: path.join(ui, "codeMenu.tsx"), folder: false });
  expect(await find("ui/codeMenu.tsx:12")).toEqual({ path: path.join(ui, "codeMenu.tsx"), folder: false });
  expect(await find("packages/ui")).toEqual({ path: ui, folder: true });
  // Two fit: no guess, unless only one's under the shell's folder.
  expect(await find("index.ts")).toBeNull();
  expect(await find("index.ts", ui)).toEqual({ path: path.join(ui, "index.ts"), folder: false });

  // Not there yet, but its folder is: to be made.
  expect(await find("sell-stuff/.env")).toEqual({ path: path.join(repo, "sell-stuff/.env"), folder: false, missing: true });
  expect(await find(".env")).toEqual({ path: path.join(repo, ".env"), folder: false, missing: true });
  // Its folder found in the repo by its end too.
  expect(await find("ui/new.ts", path.join(repo, "sell-stuff"))).toEqual({ path: path.join(ui, "new.ts"), folder: false, missing: true });
  expect(await find("nowhere/.env")).toBeNull();
  expect(await find("tab.panel")).toBeNull();
  expect(await find("useState")).toBeNull();

  // Written from a folder above the shell's (where Claude started, before its
  // shell went further in), up to the home folder.
  const home = process.env.HOME;
  process.env.HOME = repo;
  try {
    const deeper = path.join(repo, "sell-stuff");
    expect(await find("sell-stuff/notes.md", deeper)).toEqual({ path: path.join(deeper, "notes.md"), folder: false });
    expect(await find("sell-stuff/.env", deeper)).toEqual({ path: path.join(deeper, ".env"), folder: false, missing: true });
  } finally {
    process.env.HOME = home;
  }

  // A terminal's hover looks only where the shell is.
  expect(await findPaths(["codeMenu.tsx", "sell-stuff/.env"], repo)).toEqual([null, null]);
});

test("saving a new file makes its folders", async () => {
  const file = path.join(repo, "deep/er/new.md");
  expect(await writeFromPanel(file, "# Hi", null)).toMatchObject({ mtime: expect.any(Number) });
  expect(fs.readFileSync(file, "utf8")).toBe("# Hi");
});
