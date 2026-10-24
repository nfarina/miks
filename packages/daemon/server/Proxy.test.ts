import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { browseUrl } from "../shared/browse.ts";
import { connectDaemon } from "../shared/connect.ts";
import { type Daemon, serve } from "./daemon.ts";

let home: string;
let daemon: Daemon;
let socketPath: string;
// A dev server on this Mac's localhost, as `miks browse localhost:<port>` would find.
let site: http.Server;
let port: number;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  socketPath = path.join(home, "miks.sock");
  daemon = await serve({ socketPath, command: ["/bin/bash", "--norc", "--noprofile"] });
  site = http.createServer((req, res) => res.end(`${req.method} ${req.url} for ${req.headers.host}`));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  port = (site.address() as AddressInfo).port;
});

afterEach(async () => {
  await daemon.close();
  site.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("a plain-HTTP request for a full URL goes out from the daemon", async () => {
  const body = await new Promise<string>((resolve, reject) => {
    const request = http.request(
      { socketPath, path: `http://127.0.0.1:${port}/api/state?x=1`, headers: { host: `127.0.0.1:${port}` } },
      (response) => {
        let text = "";
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolve(text));
      },
    );
    request.on("error", reject);
    request.end();
  });
  // The site's own /api/state, not the daemon's.
  expect(body).toBe(`GET /api/state?x=1 for 127.0.0.1:${port}`);
});

test("a CONNECT is a tunnel from the daemon to the host and port", async () => {
  const body = await new Promise<string>((resolve, reject) => {
    const request = http.request({ socketPath, method: "CONNECT", path: `localhost:${port}` });
    request.on("connect", (response, socket) => {
      expect(response.statusCode).toBe(200);
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolve(text));
      socket.write(`GET /through HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    });
    request.on("error", reject);
    request.end();
  });
  expect(body).toMatch(/^HTTP\/1\.1 200/);
  expect(body).toContain(`GET /through for localhost:${port}`);
});

test("a CONNECT to nothing is a 502", async () => {
  site.close();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = http.request({ socketPath, method: "CONNECT", path: `127.0.0.1:${port}` });
    request.on("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  expect(status).toBe(502);
});

test("miks browse puts the page in the tab", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = daemon.workspaces.getState().workspaces[0].activeTabId!;
  const answer = await new Promise<string>((resolve, reject) => {
    const request = http.request({ socketPath, method: "POST", path: `/api/browse?pane=${tabId}` }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
    request.end("localhost:2727");
  });
  expect(JSON.parse(answer)).toEqual({ url: "http://localhost:2727/" });
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].page?.url).toBe("http://localhost:2727/");

  daemon.workspaces.closePage(tabId);
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].page).toBeUndefined();
});

test("a new tab can open on a page, after the active one", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const workspace = daemon.workspaces.getState().workspaces[0];
  const socket = connectDaemon(socketPath);
  await new Promise((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ type: "createTab", workspaceId: workspace.id, url: "localhost:2727/docs" }));
  // The page comes just after the tab, so the tab is on screen for it.
  await expect.poll(() => daemon.workspaces.getState().workspaces[0].tabs[1]?.page).toMatchObject({ url: "http://localhost:2727/docs", fill: true });
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].id).toBe(workspace.activeTabId);
  socket.close();
});

test("what miks browse takes for a web address", () => {
  expect(browseUrl("google.com")).toBe("https://google.com/");
  expect(browseUrl("localhost:2727")).toBe("http://localhost:2727/");
  expect(browseUrl("localhost:2727/dash?x=1")).toBe("http://localhost:2727/dash?x=1");
  expect(browseUrl("3000")).toBe("http://localhost:3000/");
  expect(browseUrl("192.168.1.5:8080")).toBe("http://192.168.1.5:8080/");
  expect(browseUrl("neo:5173")).toBe("http://neo:5173/");
  expect(browseUrl("app.localhost")).toBe("http://app.localhost/");
  expect(browseUrl("http://example.com")).toBe("http://example.com/");
  expect(browseUrl("file:///etc/passwd")).toBeNull();
  expect(browseUrl("  ")).toBeNull();
});
