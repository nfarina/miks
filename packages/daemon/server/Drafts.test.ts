import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { DaemonMessage } from "../shared/protocol.ts";
import { type Daemon, serve } from "./daemon.ts";

let home: string;
let daemon: Daemon;
let socketPath: string;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  socketPath = path.join(home, "miks.sock");
  daemon = await serve({ socketPath, command: ["/bin/bash", "--norc", "--noprofile"] });
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A window: connected, saying hello, keeping every draft it hears of. */
async function window() {
  const socket = connectDaemon(socketPath);
  await new Promise((resolve) => socket.once("open", resolve));
  const drafts: { tabId: string; text: string }[] = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as DaemonMessage;
    if (message.type === "draft") drafts.push({ tabId: message.tabId, text: message.text });
  });
  socket.send(JSON.stringify({ type: "hello" }));
  return { socket, drafts };
}

test("a draft goes to every other window, and to one that connects later", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = daemon.workspaces.getState().workspaces[0].activeTabId!;
  const mac = await window();
  const phone = await window();
  // Each hears of every tab's on hello, none written yet.
  await expect.poll(() => phone.drafts).toEqual([{ tabId, text: "" }]);

  mac.socket.send(JSON.stringify({ type: "draft", tabId, text: "Half a thought" }));
  await expect.poll(() => phone.drafts.at(-1)).toEqual({ tabId, text: "Half a thought" });
  // Not back to the window it came from.
  expect(mac.drafts).toEqual([{ tabId, text: "" }]);

  const later = await window();
  await expect.poll(() => later.drafts).toEqual([{ tabId, text: "Half a thought" }]);
  expect((await daemon.workspaces.save()).workspaces[0].tabs[0].draft).toBe("Half a thought");

  for (const each of [mac, phone, later]) each.socket.close();
});

test("a window that was away hears that a draft was sent (emptied) while it was gone", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = daemon.workspaces.getState().workspaces[0].activeTabId!;
  const mac = await window();
  mac.socket.send(JSON.stringify({ type: "draft", tabId, text: "Run the tests" }));
  await expect.poll(() => daemon.workspaces.getDrafts()).toEqual([[tabId, "Run the tests"]]);
  mac.socket.send(JSON.stringify({ type: "draft", tabId, text: "" }));
  await expect.poll(() => daemon.workspaces.getDrafts()).toEqual([[tabId, ""]]);

  const phone = await window();
  await expect.poll(() => phone.drafts).toEqual([{ tabId, text: "" }]);
  for (const each of [mac, phone]) each.socket.close();
});
