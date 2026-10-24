import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { DaemonMessage } from "../shared/protocol.ts";
import { type Daemon, serve } from "./daemon.ts";

let home: string;
let daemon: Daemon;

afterEach(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("a window with only the socket (the iOS app's) asks what's running, then restarts the daemon", async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  const restarts: boolean[] = [];
  daemon = await serve({
    socketPath: path.join(home, "miks.sock"),
    command: ["/bin/bash", "--norc", "--noprofile"],
    onStop: (restart) => restarts.push(restart),
  });
  daemon.workspaces.createWorkspace({ cwd: home });

  const socket = connectDaemon(path.join(home, "miks.sock"));
  await new Promise((resolve) => socket.once("open", resolve));
  const messages: DaemonMessage[] = [];
  socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));

  socket.send(JSON.stringify({ type: "running", requestId: "r1" }));
  await expect.poll(() => messages.find((message) => message.type === "running")).toMatchObject({ requestId: "r1", running: expect.any(Array) });

  socket.send(JSON.stringify({ type: "restart" }));
  await expect.poll(() => restarts).toEqual([true]);
  socket.close();
});
