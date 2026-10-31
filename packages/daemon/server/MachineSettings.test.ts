import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { DaemonMessage } from "../shared/protocol.ts";
import { type Daemon, serve } from "./daemon.ts";

let home: string;
let daemon: Daemon | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
});

afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  fs.rmSync(home, { recursive: true, force: true });
});

const start = async () => (daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: ["/bin/bash", "--norc", "--noprofile"] }));

test("a Mac's settings start from settings.json's, and any window changes them for every window", async () => {
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ hidePathPrefix: "~/Code/", fontSize: 15 }));
  const { workspaces } = await start();
  expect(workspaces.getState().machine).toEqual({ hidePathPrefix: "~/Code/", searchFolders: "~/Code", tailnetAccess: false, keepAvailable: "off" });

  const states: DaemonMessage[] = [];
  const socket = connectDaemon(path.join(home, "miks.sock"));
  await new Promise((resolve) => socket.once("open", resolve));
  socket.on("message", (raw) => states.push(JSON.parse(raw.toString())));
  // A window on this Mac, or another's, or the iOS app: all the same here. The wrong type, or a choice there isn't, is no change.
  socket.send(JSON.stringify({ type: "machineSettings", changes: { tailnetAccess: true, hidePathPrefix: 7, keepAvailable: "always" } }));
  await expect
    .poll(() => states.findLast((message) => message.type === "state")?.state.machine)
    .toEqual({ hidePathPrefix: "~/Code/", searchFolders: "~/Code", tailnetAccess: true, keepAvailable: "off" });
  socket.close();

  // Kept, in a file of the daemon's own.
  expect(JSON.parse(fs.readFileSync(path.join(home, "machine.json"), "utf8"))).toEqual({ hidePathPrefix: "~/Code/", searchFolders: "~/Code", tailnetAccess: true, keepAvailable: "off" });
  fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ hidePathPrefix: "elsewhere" }));
  await daemon!.close();
  expect((await start()).workspaces.getMachineSettings()).toEqual({ hidePathPrefix: "~/Code/", searchFolders: "~/Code", tailnetAccess: true, keepAvailable: "off" });
});
