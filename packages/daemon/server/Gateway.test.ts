import { execFileSync } from "child_process";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { type Daemon, serve } from "./daemon.ts";
import { Gateway, type Tailscale } from "./Gateway.ts";

let home: string;
let daemon: Daemon;
let gateway: Gateway;
let port: number;
// Who Tailscale says is connecting; every test connection comes from 127.0.0.1.
let caller: { node: string; owner: string } | null;
let running: boolean;
// Whether the tailnet has HTTPS certificates on, and the one it gives.
let certified: { cert: string; key: string } | null;

const tailscale: Tailscale = {
  self: async () =>
    running
      ? { addresses: ["127.0.0.1"], name: "air", node: "air-node", owner: "me", domain: certified ? "localhost" : undefined }
      : null,
  whois: async () => caller,
  cert: async () => certified!,
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks gateway-"));
  const uiDir = path.join(home, "ui");
  fs.mkdirSync(path.join(uiDir, "assets"), { recursive: true });
  fs.writeFileSync(
    path.join(uiDir, "index.html"),
    `<head><meta http-equiv="Content-Security-Policy" content="connect-src 'self' ws://localhost:*"></head>`,
  );
  fs.writeFileSync(path.join(uiDir, "assets", "app.js"), "console.log('miks')");
  fs.writeFileSync(path.join(home, "secret.txt"), "not for you");

  const socketPath = path.join(home, "miks.sock");
  daemon = await serve({ socketPath, command: ["/bin/bash", "--norc", "--noprofile"] });
  port = await freePort();
  caller = { node: "ipad-node", owner: "me" };
  running = true;
  certified = null;
  gateway = new Gateway({ socketPath, uiDir, tailscale, port });
});

afterEach(async () => {
  gateway.close();
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

const get = (pathname: string) => fetch(`http://127.0.0.1:${port}${pathname}`);

test("off until turned on, and says why it can't listen", async () => {
  await expect(get("/")).rejects.toThrow();

  running = false;
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state);
  expect(gateway.state).toEqual({ error: "Tailscale isn't running on this Mac." });
});

test("serves the UI to your own other devices, and nothing to anyone else", async () => {
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state && "url" in gateway.state);
  expect(gateway.state).toEqual({ url: `http://air:${port}/` });

  const page = await get("/");
  expect(page.status).toBe(200);
  // It may open its WebSocket back to where it came from.
  const html = await page.text();
  expect(html).toContain(`connect-src 'self' ws://127.0.0.1:${port} wss://127.0.0.1:${port}`);
  expect(html).toContain(`<meta name="miks-gateway" />`);
  expect(await (await get("/assets/app.js")).text()).toBe("console.log('miks')");
  expect((await get("/../secret.txt")).status).toBe(404);
  expect((await get("/%2e%2e/secret.txt")).status).toBe(404);

  // Someone else's device, on a shared tailnet.
  caller = { node: "their-node", owner: "someone else" };
  gateway = (gateway.close(), new Gateway({ socketPath: path.join(home, "miks.sock"), uiDir: path.join(home, "ui"), tailscale, port }));
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state);
  expect((await get("/")).status).toBe(403);

  // This Mac itself: any web page in a browser here could get that far.
  caller = { node: "air-node", owner: "me" };
  gateway = (gateway.close(), new Gateway({ socketPath: path.join(home, "miks.sock"), uiDir: path.join(home, "ui"), tailscale, port }));
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state);
  expect((await get("/")).status).toBe(403);
});

test("its WebSocket is the daemon's, for its own page only", async () => {
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state && "url" in gateway.state);

  const first = await new Promise<any>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    socket.on("open", () => socket.send(JSON.stringify({ type: "hello" })));
    socket.on("message", (data) => {
      resolve(JSON.parse(data.toString()));
      socket.close();
    });
    socket.on("error", reject);
  });
  expect(first.type).toBe("state");

  // The iOS app's page, from its cached bundle.
  const app = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: "crosswing://app" } });
    socket.on("open", () => (socket.close(), resolve("opened")));
    socket.on("error", (error) => resolve(error.message));
  });
  expect(app).toBe("opened");

  // A page from anywhere else (one rebinding its name to this address, say).
  const refused = await new Promise<string>((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: "http://evil.example" } });
    socket.on("error", (error) => resolve(error.message));
    socket.on("open", () => resolve("opened"));
  });
  expect(refused).toContain("403");
});

test("it's a proxy from this Mac for your own devices: plain HTTP and CONNECT tunnels", async () => {
  // A dev server on this Mac's localhost.
  const site = http.createServer((req, res) => res.end(`site ${req.url}`));
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const sitePort = (site.address() as net.AddressInfo).port;
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state && "url" in gateway.state);

  const plain = await new Promise<string>((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: `http://localhost:${sitePort}/a` }, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
  expect(plain).toBe("site /a");

  const tunneled = await new Promise<string>((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: `localhost:${sitePort}` });
    req.on("connect", (res, socket) => {
      expect(res.statusCode).toBe(200);
      socket.write(`GET /b HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
      let text = "";
      socket.on("data", (chunk) => (text += chunk));
      socket.on("end", () => resolve(text.split("\r\n\r\n")[1]));
    });
    req.on("error", reject);
    req.end();
  });
  expect(tunneled).toBe("site /b");

  // Not for anyone else's device.
  caller = { node: "their-node", owner: "someone else" };
  gateway = (gateway.close(), new Gateway({ socketPath: path.join(home, "miks.sock"), uiDir: path.join(home, "ui"), tailscale, port }));
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state);
  const refused = await new Promise<number | undefined>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: `localhost:${sitePort}` });
    req.on("connect", (res) => resolve(res.statusCode));
    req.on("error", () => resolve(undefined));
    req.end();
  });
  expect(refused).toBe(403);
  site.close();
});

test("with a certificate from the tailnet, it's HTTPS at the full name", async () => {
  const key = path.join(home, "key.pem");
  const cert = path.join(home, "cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", key, "-out", cert], { stdio: "ignore" });
  certified = { cert: fs.readFileSync(cert, "utf8"), key: fs.readFileSync(key, "utf8") };

  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state && "url" in gateway.state);
  expect(gateway.state).toEqual({ url: `https://localhost:${port}/` });

  const status = await new Promise<number | undefined>((resolve, reject) => {
    https.get({ host: "127.0.0.1", port, path: "/", ca: certified!.cert, servername: "localhost" }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  expect(status).toBe(200);
});

test("turning it off closes it", async () => {
  gateway.setEnabled(true);
  await waitFor(() => !!gateway.state && "url" in gateway.state);
  gateway.setEnabled(false);
  expect(gateway.state).toBeUndefined();
  await expect(get("/")).rejects.toThrow();
});
