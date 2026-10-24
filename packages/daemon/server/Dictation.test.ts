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

/** Sends one request and waits for the answer of `type` to it. */
async function ask(request: object, type: string): Promise<any> {
  const socket = connectDaemon(socketPath);
  await new Promise((resolve) => socket.once("open", resolve));
  const answer = new Promise((resolve) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as DaemonMessage;
      if (message.type === type) resolve(message);
    }),
  );
  socket.send(JSON.stringify(request));
  const result = await answer;
  socket.close();
  return result;
}

test("a device's file lands in the tmpdir under its own name", async () => {
  const data = Buffer.from("a photo, say").toString("base64");
  const answer = await ask({ type: "sendFile", requestId: "1", name: "../IMG_0001.jpeg", data }, "fileSent");
  expect(answer.requestId).toBe("1");
  expect(path.basename(answer.path)).toBe("IMG_0001.jpeg");
  expect(fs.realpathSync(answer.path).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  expect(fs.readFileSync(answer.path, "utf8")).toBe("a photo, say");
  fs.rmSync(path.dirname(answer.path), { recursive: true });
});

test("dictation without a Groq key says where one goes", async () => {
  const answer = await ask({ type: "transcribe", requestId: "2", audio: "", mime: "audio/mp4" }, "transcribed");
  expect(answer).toMatchObject({ requestId: "2", error: expect.stringContaining(path.join(home, "keys.json")) });
});
