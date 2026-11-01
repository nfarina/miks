import { expect, it } from "vitest";
import { filterTree, type TreeFile } from "./filterTree";

const file = (path: string, ignored?: boolean): TreeFile => ({ path, folder: false, ignored });
const folder = (path: string): TreeFile => ({ path, folder: true });
const shown = (files: TreeFile[], query: string) => filterTree("/r", files, query).map((row) => `${" ".repeat(row.depth)}${row.name}`);

it("shows matches with the folders down to them", () => {
  const files = [file("/r/ui/ChatPanel.tsx"), file("/r/ui/App.tsx"), file("/r/daemon/deep/Chat.ts"), file("/r/README.md")];
  expect(shown(files, "chat")).toEqual(["daemon", " deep", "  Chat.ts", "ui", " ChatPanel.tsx"]);
  expect(filterTree("/r", files, "chat")[0]).toMatchObject({ expanded: true, hits: [] });
});

it("goes by the name, not the folders above it", () => {
  expect(shown([file("/r/ui/App.tsx"), file("/r/quiet.md")], "ui")).toEqual(["ui", "quiet.md"]);
});

it("keeps a folder fitting by name shut", () => {
  const [row] = filterTree("/r", [folder("/r/ui"), file("/r/ui/App.tsx")], "ui");
  expect(row).toMatchObject({ expanded: false, hits: [0, 1] });
});

it("takes each word by itself", () => {
  expect(shown([file("/r/ChatPanel.tsx"), file("/r/Panel.tsx")], "panel chat")).toEqual(["ChatPanel.tsx"]);
});

it("merges repeats, keeps what's ignored, and leaves out what's elsewhere", () => {
  const rows = filterTree("/r", [file("/r/a.log"), file("/r/a.log", true), file("/rest/a.log"), file("/other/a.log")], "log");
  expect(rows.map((row) => row.path)).toEqual(["/r/a.log"]);
  expect(rows[0].entry.ignored).toBe(true);
});

it("scores only files, the better fit higher", () => {
  const rows = filterTree("/r", [file("/r/filter/FileInput.tsx"), file("/r/filter/filterTree.ts")], "filt");
  const [folderRow, ...fileRows] = rows;
  expect(folderRow.score).toBe(-Infinity);
  expect(fileRows.find((row) => row.name === "filterTree.ts")!.score).toBeGreaterThan(fileRows.find((row) => row.name === "FileInput.tsx")!.score);
});
