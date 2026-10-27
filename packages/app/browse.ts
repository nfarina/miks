// The panel's browser (`miks browse`) loads everything through the window's
// daemon, so a remote window's `localhost` is the remote's, on every port.
// Chromium takes a proxy only as host:port, never a Unix socket, so each
// daemon gets a front here, on 127.0.0.1, that hands every connection to its
// socket (through its gateway, for a remote; the daemon's proxy is
// packages/daemon/server/Proxy.ts). Any user of this Mac can reach a port on
// 127.0.0.1, where the socket is ours alone, so the front asks for a password
// that only its session is given (the `login` event).
import { randomBytes } from "crypto";
import { app, session } from "electron";
import http from "http";
import type { Duplex } from "stream";

type Front = { port: number; user: string; password: string };

/** Each daemon's front and session, by window key (a remote's id, or local). */
const fronts = new Map<string, Promise<Front>>();

/**
 * The session for a window's pages, set up to go through its daemon:
 * `socket` resolves to the daemon's socket (the tunnel's, which can change
 * as it restarts, so it's asked for each connection). Each Mac's pages get
 * their own cookies and storage: localhost:3000 on one is not on another.
 */
export async function browsePartition(key: string, socket: () => Promise<string>): Promise<string> {
  const partition = `persist:browse-${key}`;
  let front = fronts.get(key);
  if (!front) {
    front = startFront(socket).then(async (started) => {
      // `<-loopback>` takes back Chromium's own rule never to proxy
      // localhost, the very address that's to be the daemon's.
      await session.fromPartition(partition).setProxy({
        proxyRules: `127.0.0.1:${started.port}`,
        proxyBypassRules: "<-loopback>",
      });
      return started;
    });
    front.catch(() => fronts.delete(key));
    fronts.set(key, front);
  }
  await front;
  return partition;
}

/** Whether a webview may have this session: only its own window's. */
export const isBrowsePartition = (key: string, partition: string | undefined) => partition === `persist:browse-${key}`;

// The front's challenge, answered with its password (and only for it).
app.on("login", (event, _contents, _details, authInfo, callback) => {
  if (!authInfo.isProxy || authInfo.host !== "127.0.0.1") return;
  void (async () => {
    for (const front of fronts.values()) {
      const { port, user, password } = await front;
      if (port === authInfo.port) return callback(user, password);
    }
    callback();
  })();
  event.preventDefault();
});

async function startFront(socket: () => Promise<string>): Promise<Front> {
  const user = "miks";
  const password = randomBytes(18).toString("base64url");
  const authorization = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const authorized = (req: http.IncomingMessage) => req.headers["proxy-authorization"] === authorization;
  const CHALLENGE = 'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Miks"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';

  // Plain HTTP: the request, for its full URL, to the daemon.
  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="Miks"', Connection: "close" }).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-authorization"];
    delete headers["proxy-connection"];
    let socketPath: string;
    try {
      socketPath = await socket();
    } catch {
      res.writeHead(502).end();
      return;
    }
    const upstream = http.request({ socketPath, method: req.method, path: req.url, headers }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });

  // HTTPS and WebSockets: a tunnel, which the daemon opens.
  server.on("connect", async (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on("error", () => {});
    if (!authorized(req)) return client.end(CHALLENGE);
    let socketPath: string;
    try {
      socketPath = await socket();
    } catch {
      return client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    }

    const request = http.request({ socketPath, method: "CONNECT", path: req.url, headers: { host: req.url } });
    request.on("connect", (response, upstream, upstreamHead) => {
      if (response.statusCode !== 200) {
        upstream.destroy();
        return client.end(`HTTP/1.1 ${response.statusCode ?? 502} ${response.statusMessage ?? ""}\r\n\r\n`);
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (upstreamHead.length > 0) client.write(upstreamHead);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => client.destroy());
      client.on("close", () => upstream.destroy());
    });
    request.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
    request.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The browser's proxy didn't start.");
  return { port: address.port, user, password };
}
