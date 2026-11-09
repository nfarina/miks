import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { DaemonMessage, Tab } from "../shared/protocol.ts";
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

/** A window: connected, saying hello, keeping the first tab as the latest `state` has it. */
async function window() {
  const socket = connectDaemon(socketPath);
  await new Promise((resolve) => socket.once("open", resolve));
  const seen: { tab?: Tab } = {};
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as DaemonMessage;
    if (message.type === "state") seen.tab = message.state.workspaces[0]?.tabs[0];
  });
  socket.send(JSON.stringify({ type: "hello" }));
  return { socket, seen };
}

test("a tab's panel, as one window leaves it, is every window's, and outlasts a restart", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = daemon.workspaces.getState().workspaces[0].activeTabId!;
  const mac = await window();
  await expect.poll(() => mac.seen.tab?.id).toBe(tabId);
  expect(mac.seen.tab?.panel).toBeUndefined();

  mac.socket.send(JSON.stringify({ type: "panel", tabId, open: true }));
  mac.socket.send(JSON.stringify({ type: "panel", tabId, view: "files" }));
  await expect.poll(() => mac.seen.tab?.panel).toEqual({ open: true, view: "files" });

  // A phone connecting later shows it the same.
  const phone = await window();
  await expect.poll(() => phone.seen.tab?.panel).toEqual({ open: true, view: "files" });

  expect((await daemon.workspaces.save()).workspaces[0].tabs[0].panel).toEqual({ open: true, view: "files" });

  // A file's view names this opening of it, which a restore won't bring back.
  mac.socket.send(JSON.stringify({ type: "panel", tabId, view: "file:abc" }));
  await expect.poll(() => phone.seen.tab?.panel?.view).toBe("file:abc");
  expect((await daemon.workspaces.save()).workspaces[0].tabs[0].panel).toEqual({ open: true });

  for (const each of [mac, phone]) each.socket.close();
});
