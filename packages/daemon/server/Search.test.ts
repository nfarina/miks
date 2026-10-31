import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SearchFile, SearchOptions } from "../shared/protocol.ts";
import { listFiles, readFolder, searchFiles } from "./Search.ts";

const OPTIONS: Omit<SearchOptions, "query" | "roots"> = { regex: false, caseSensitive: false, wholeWord: false, everything: false, include: "", exclude: "" };

function search(query: string, roots: string[], options: Partial<SearchOptions> = {}) {
  return new Promise<{ files: SearchFile[]; end: { truncated?: boolean; error?: string } }>((resolve) => {
    const files: SearchFile[] = [];
    searchFiles({ ...OPTIONS, query, roots, ...options }, (found, end) => {
      files.push(...found);
      if (end) resolve({ files, end });
    });
  });
}

describe("Search", () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miks-search-")));
    execFileSync("git", ["init", "-q"], { cwd: root });
    fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.mkdirSync(path.join(root, "dist"));
    fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(root, "src/a.ts"), "const héllo = needle;\n  // Needle, needle.\nno match here\n");
    fs.writeFileSync(path.join(root, "dist/a.js"), "needle\n");
    fs.writeFileSync(path.join(root, "node_modules/x/index.js"), "needle\n");
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it("finds matches, skipping ignored files, with offsets in characters", async () => {
    const { files } = await search("needle", [root]);
    expect(files.map((file) => path.relative(root, file.path))).toEqual(["src/a.ts"]);
    const [first, second] = files[0].matches;
    // The é is two bytes.
    expect(first).toMatchObject({ line: 1, column: 14, length: 6 });
    expect(first.text.slice(...first.ranges[0])).toBe("needle");
    // Its indent's left off the text, and both hits are in it.
    expect(second.text.startsWith("//")).toBe(true);
    expect(second.ranges).toHaveLength(2);
  });

  it("honors case, and searches ignored files when asked", async () => {
    expect((await search("Needle", [root], { caseSensitive: true })).files[0].matches).toHaveLength(1);
    const { files } = await search("needle", [root], { everything: true });
    expect(files.map((file) => path.relative(root, file.path)).sort()).toEqual(["dist/a.js", "node_modules/x/index.js", "src/a.ts"]);
  });

  it("says what's wrong with a bad regex or missing folders", async () => {
    expect((await search("(", [root], { regex: true })).end.error).toBeTruthy();
    expect((await search("x", ["/nothing/here"])).end.error).toBeTruthy();
  });

  it("lists a repo's files from inside it", async () => {
    const { root: found, paths } = await listFiles(path.join(root, "src"));
    expect(found).toBe(root);
    expect(paths).toEqual(["src/a.ts"]);
  });

  it("lists a folder with folders first, marking what's ignored", async () => {
    const entries = await readFolder(root);
    expect(entries.map((entry) => entry.name)).toEqual(["dist", "node_modules", "src", ".gitignore"]);
    expect(entries.find((entry) => entry.name === "dist")?.ignored).toBe(true);
    expect(entries.find((entry) => entry.name === "src")?.ignored).toBeUndefined();
  });
});
