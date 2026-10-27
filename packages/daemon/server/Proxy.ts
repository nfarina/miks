import http from "http";
import net from "net";
import type { Duplex } from "stream";

/**
 * The panel's browser (`miks browse`) goes out from here, the daemon's Mac,
 * whichever Mac the window is on: its whole session uses this as its proxy
 * (through Electron main and, for a remote window, the gateway), so
 * `localhost` is this Mac's, on any port, and so are its DNS and VPN. HTTPS
 * and WebSockets arrive as CONNECT tunnels (encrypted end to end, so
 * certificates are checked as usual); plain HTTP as requests for a full URL.
 */

/** Whether a request is for the proxy, not the daemon's API: its URL is a full one. */
export const isProxyRequest = (req: http.IncomingMessage) => /^http:\/\//i.test(req.url ?? "");

/** Headers for one connection only, which a proxy doesn't pass on. */
const HOP_BY_HOP = ["connection", "keep-alive", "proxy-connection", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

/** A plain-HTTP request for a full URL, made from here. */
export function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse) {
  let target: URL;
  try {
    target = new URL(req.url!);
  } catch {
    res.writeHead(400).end();
    return;
  }

  const headers = { ...req.headers };
  for (const name of HOP_BY_HOP) delete headers[name];
  const upstream = http.request(
    {
      host: target.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers,
    },
    (response) => {
      const back = { ...response.headers };
      for (const name of HOP_BY_HOP) delete back[name];
      res.writeHead(response.statusCode ?? 502, response.statusMessage, back);
      response.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** A CONNECT: a TCP connection from here to `host:port`, piped both ways. */
export function proxyConnect(req: http.IncomingMessage, client: Duplex, head: Buffer) {
  const match = (req.url ?? "").match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!match) {
    client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }

  let connected = false;
  const upstream = net.connect({ host: match[1], port: Number(match[2]) });
  upstream.once("connect", () => {
    connected = true;
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  upstream.on("error", () => {
    if (connected) client.destroy();
    else client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  upstream.on("close", () => client.destroy());
  client.on("error", () => upstream.destroy());
  client.on("close", () => upstream.destroy());
}
