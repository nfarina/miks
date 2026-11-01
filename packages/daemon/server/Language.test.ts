import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { findDefinition, stopLanguageServers } from "./Language.ts";

describe("findDefinition", () => {
  let root: string;
  const app = `import { target } from "./lib";\ntarget();\n`;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "miks-language-")));
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, "tsconfig.json"), `{"compilerOptions":{"module":"esnext","moduleResolution":"bundler"}}`);
    fs.writeFileSync(path.join(root, "lib.ts"), "export function target() {}\n");
    fs.writeFileSync(path.join(root, "app.ts"), app);
  });

  afterAll(() => {
    stopLanguageServers();
    fs.rmSync(root, { recursive: true });
  });

  it("finds it in another file", async () => {
    const found = await findDefinition(path.join(root, "app.ts"), app, 2, 2);
    expect(found).toEqual({ path: path.join(root, "lib.ts"), line: 1, column: 16, length: 6 });
  });

  it("goes by the editor's text, saved or not", async () => {
    const edited = `// A line.\n${app}\nfunction local() {}\nlocal();\n`;
    const found = await findDefinition(path.join(root, "app.ts"), edited, 6, 1);
    expect(found).toMatchObject({ path: path.join(root, "app.ts"), line: 5, column: 9 });
  });

  it("sees files changing on disk", async () => {
    fs.writeFileSync(path.join(root, "lib.ts"), "// One.\n// Two.\nexport function target() {}\n");
    // Under 300ms after the write, it still has the old one.
    await vi.waitFor(async () => {
      const found = await findDefinition(path.join(root, "app.ts"), app, 2, 2);
      expect(found).toMatchObject({ path: path.join(root, "lib.ts"), line: 3 });
    });
  });

  it("finds nothing for what isn't a symbol", async () => {
    expect(await findDefinition(path.join(root, "app.ts"), app, 1, 0)).toBeNull();
  });

  it("starts again once stopped", async () => {
    stopLanguageServers();
    const found = await findDefinition(path.join(root, "app.ts"), app, 2, 2);
    expect(found?.path).toBe(path.join(root, "lib.ts"));
  });

  it("leaves other languages alone", async () => {
    expect(await findDefinition(path.join(root, "notes.md"), "target", 1, 0)).toBeNull();
  });
});
