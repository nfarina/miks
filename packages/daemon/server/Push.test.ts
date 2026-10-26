import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AgentStatus, DaemonState } from "../shared/protocol.ts";
import { plainText, Push } from "./Push.ts";

let home: string;
let sent: any[];
let idle: number;
let showing: Set<string>;
let push: Push;

beforeEach(() => {
  vi.useFakeTimers();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks push-"));
  sent = [];
  idle = 0;
  showing = new Set();
  push = makePush();
  push.register({ id: "sealed-1", deviceId: "phone", name: "iPhone", host: "air.tail.ts.net:2741" });
});

afterEach(() => {
  push.close();
  vi.useRealTimers();
  fs.rmSync(home, { recursive: true, force: true });
});

function makePush(answer: () => object = () => ({ ok: true })) {
  return new Push({
    home,
    onScreen: (deviceId) => showing.has(deviceId),
    send: async (body) => (sent.push(body), answer()),
    idleTime: async () => idle,
  });
}

/** One workspace, one tab, its agent in that status. */
function state(status: AgentStatus | null, reply?: string): DaemonState {
  return {
    home: "/Users/test",
    activeWorkspaceId: "w",
    workspaces: [
      {
        id: "w",
        title: "miks",
        cwd: "/",
        activeTabId: "t",
        tabs: [
          {
            id: "t",
            key: "k",
            title: "✳ Claude",
            cwd: "/",
            agent: status && { kind: "claude", status, since: 0, reply },
          },
        ],
      },
    ],
  };
}

/** Lets the idle check (a promise) and any timers due by then run. */
const after = async (ms: number) => vi.advanceTimersByTimeAsync(ms);

test("nobody at the Mac: pushes at once, and clears once it's answered", async () => {
  idle = 5 * 60_000;
  push.update(state("working"));
  push.update(state("waiting"));
  await after(0);
  expect(sent).toEqual([
    {
      id: "sealed-1",
      alert: {
        title: "miks",
        subtitle: "air",
        body: "Needs your input",
        thread: "k",
        mac: "air.tail.ts.net:2741",
        tabId: "t",
      },
    },
  ]);

  push.update(state("working"));
  expect(sent[1]).toEqual({ id: "sealed-1", clear: ["k"] });
});

test("someone at the Mac: waits a minute, and pushes nothing if it's seen meanwhile", async () => {
  push.update(state("working"));
  push.update(state("done", "All **done** — see `App.tsx`."));
  await after(59_000);
  expect(sent).toEqual([]);
  push.seen("t");
  await after(5_000);
  expect(sent).toEqual([]);

  push.update(state("working"));
  push.update(state("done", "Again."));
  await after(60_000);
  expect(sent.map((body) => body.alert?.body)).toEqual(["Again."]);
});

test("a window left on the tab at an idle Mac doesn't stop the push, nor does done going idle", async () => {
  idle = 5 * 60_000;
  push.update(state("working"));
  push.update(state("done"));
  await push.seenAtMac("t");
  push.update(state("idle"));
  await after(0);
  expect(sent.map((body) => body.alert?.title)).toEqual(["miks"]);

  // Selecting it, or looking on a device, does.
  push.seen("t");
  expect(sent[1]).toEqual({ id: "sealed-1", clear: ["k"] });
});

test("a window left on the tab as you walk away: pushed, unless the Mac's touched within the minute", async () => {
  push.update(state("working"));
  push.update(state("done"));
  await push.seenAtMac("t");
  idle = 60_000;
  await after(60_000);
  expect(sent.map((body) => body.alert?.title)).toEqual(["miks"]);

  idle = 0;
  push.update(state("working"));
  push.update(state("done"));
  await push.seenAtMac("t");
  idle = 20_000;
  await after(60_000);
  // Only the first push's clear (it went from working), and no second push.
  expect(sent.slice(1)).toEqual([{ id: "sealed-1", clear: ["k"] }]);
});

test("coming back to a window left on the tab, and using it, clears the push", async () => {
  idle = 5 * 60_000;
  push.update(state("working"));
  push.update(state("done"));
  await push.seenAtMac("t");
  await after(0);
  expect(sent).toHaveLength(1);

  idle = 0;
  await push.seenAtMac("t");
  expect(sent[1]).toEqual({ id: "sealed-1", clear: ["k"] });
});

test("seen while the idle check is still out calls the push off", async () => {
  idle = 5 * 60_000;
  push.update(state("working"));
  push.update(state("waiting"));
  push.seen("t");
  await after(60_000);
  expect(sent).toEqual([]);
});

test("what was so at startup isn't news, and a device showing this Mac gets nothing", async () => {
  idle = 5 * 60_000;
  push.update(state("waiting"));
  await after(60_000);
  expect(sent).toEqual([]);

  showing.add("phone");
  push.update(state("working"));
  push.update(state("done"));
  await after(60_000);
  expect(sent).toEqual([]);
});

test("a device the relay says is gone is forgotten, for good", async () => {
  push.close();
  push = makePush(() => ({ gone: true }));
  idle = 5 * 60_000;
  push.update(state("working"));
  push.update(state("waiting"));
  await after(0);
  expect(sent).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(path.join(home, "devices.json"), "utf8"))).toEqual([]);
});

test("devices are kept across restarts", () => {
  expect(JSON.parse(fs.readFileSync(path.join(home, "devices.json"), "utf8"))).toEqual([
    { id: "sealed-1", deviceId: "phone", name: "iPhone", host: "air.tail.ts.net:2741" },
  ]);
});

test("a reply's markdown, as a line of text", () => {
  expect(plainText("## Done\n\n- Fixed **the bug** in `App.tsx`\n- See [the docs](https://x)")).toBe(
    "Done Fixed the bug in App.tsx See the docs",
  );
});
