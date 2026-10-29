import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { type Daemon, serve } from "./daemon.ts";

let home: string;
let daemon: Daemon;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: ["/bin/bash", "--norc", "--noprofile"] });
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const workspaces = () => daemon.workspaces.getState().workspaces;
const screen = (tabId: string) => daemon.workspaces.getPane(tabId)?.snapshot().screen ?? "";

test("a closed tab comes back where it was, with its panel and what its terminal showed", async () => {
  const workspaceId = daemon.workspaces.createWorkspace({ cwd: home });
  const first = workspaces()[0].tabs[0].id;
  const tabId = daemon.workspaces.createTab(workspaceId)!;
  daemon.workspaces.createTab(workspaceId);
  daemon.workspaces.getPane(tabId)!.write("echo marker-$((6*7))\r");
  await expect.poll(() => screen(tabId)).toContain("marker-42");
  const notes = path.join(home, "notes.md");
  fs.writeFileSync(notes, "# Notes\n");
  await daemon.workspaces.openFile(tabId, notes, { edit: false, wait: false });
  daemon.workspaces.openPage(tabId, "http://localhost:2727/");
  const key = workspaces()[0].tabs[1].key;

  daemon.workspaces.closeTab(tabId);
  await expect.poll(() => workspaces()[0].tabs.length).toBe(2);
  daemon.workspaces.reopen();

  const tabs = workspaces()[0].tabs;
  expect(tabs).toHaveLength(3);
  expect(tabs[0].id).toBe(first);
  const reopened = tabs[1];
  expect(reopened).toMatchObject({ key, page: { url: "http://localhost:2727/" }, files: [{ path: notes }] });
  expect(workspaces()[0].activeTabId).toBe(reopened.id);
  await expect.poll(() => screen(reopened.id)).toContain("marker-42");
});

test("closing a workspace's last tab closes the workspace, and ⌘⇧T brings both back", async () => {
  daemon.workspaces.createWorkspace({ cwd: home, title: "First" });
  const workspaceId = daemon.workspaces.createWorkspace({ cwd: home, title: "Second" });
  daemon.workspaces.closeTab(workspaces()[1].tabs[0].id);
  await expect.poll(() => workspaces().length).toBe(1);

  daemon.workspaces.reopen();
  expect(workspaces().map((w) => w.title)).toEqual(["First", "Second"]);
  expect(workspaces()[1].id).not.toBe(workspaceId);
  expect(workspaces()[1].tabs).toHaveLength(1);
  expect(daemon.workspaces.getState().activeWorkspaceId).toBe(workspaces()[1].id);
});

test("a file or page closed from the panel comes back into its tab, the latest first", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = workspaces()[0].tabs[0].id;
  const notes = path.join(home, "notes.md");
  fs.writeFileSync(notes, "# Notes\n");
  await daemon.workspaces.openFile(tabId, notes, { edit: false, wait: false });
  daemon.workspaces.openPage(tabId, "http://localhost:2727/");

  daemon.workspaces.closeFileByHand(tabId);
  daemon.workspaces.closePage(tabId);
  expect(workspaces()[0].tabs[0]).toMatchObject({ files: undefined, page: undefined });

  daemon.workspaces.reopen();
  expect(workspaces()[0].tabs[0]).toMatchObject({ files: undefined, page: { url: "http://localhost:2727/" } });
  daemon.workspaces.reopen();
  expect(workspaces()[0].tabs[0].files).toMatchObject([{ path: notes }]);
  // Nothing left: nothing happens.
  daemon.workspaces.reopen();
  expect(workspaces()[0].tabs).toHaveLength(1);
});
