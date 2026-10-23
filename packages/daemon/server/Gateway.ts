import { execFile } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import http from "http";
import https from "https";
import type { Duplex } from "stream";
import path from "path";
import { WebSocketServer } from "ws";
import { connectDaemon } from "../shared/connect.ts";
import type { GatewayState } from "../shared/protocol.ts";
import { isProxyRequest, proxyConnect, proxyRequest } from "./Proxy.ts";

/** The port on each of this Mac's Tailscale addresses. */
export const GATEWAY_PORT = 2741;

/** How often a listening gateway checks its addresses (and one that failed tries again). */
const CHECK_INTERVAL = 30_000;

/**
 * Pages besides its own that may open its WebSocket: the iOS app's, from its
 * cached bundle (`crosswing://app`, a scheme no website can have) or live
 * from where the bundle is hosted. Any other page, even on your own devices,
 * is refused: a site in the iPad's browser passes the device check too.
 */
export const APP_ORIGINS = ["crosswing://app", "https://miks-app.nfarina.com"];

/** How often the certificate is asked for again (Tailscale renews it, well before it expires). */
const CERT_INTERVAL = 24 * 60 * 60_000;

/** How long who's at an address is remembered. */
const OWNER_TTL = 60_000;

/** A device on the tailnet: which one (its stable ID), and the user it's signed in as. */
type Device = { node: string; owner: string };

/** This Mac on the tailnet: its addresses, its short name, and its full one when it can have a certificate. */
type Self = Device & { addresses: string[]; name: string; domain?: string };

/** What the gateway asks Tailscale: this Mac on the tailnet, who's at an address, and a certificate. */
export type Tailscale = {
  /** This Mac, or null when Tailscale isn't running (or isn't installed). */
  self(): Promise<Self | null>;
  /** The device at an address, or null for one that isn't on the tailnet. */
  whois(address: string): Promise<Device | null>;
  /** A certificate for this Mac's full name (Let's Encrypt's, through Tailscale), with its key. */
  cert(domain: string): Promise<{ cert: string; key: string }>;
};

/**
 * Miks for your other devices on Tailscale (an iPad, a phone), in a browser:
 * the UI, and a WebSocket piped to the daemon's own socket, which stays the
 * only way in for everything else. Listens only on this Mac's Tailscale
 * addresses, so nothing on the LAN or the internet reaches it, and lets in
 * only devices signed in (by `tailscale whois`) as this Mac's owner. Never
 * this Mac itself: from here, any web page in a browser could reach it, as
 * it could localhost. Off unless turned on in Settings.
 */
export class Gateway extends EventEmitter<{ change: [] }> {
  state: GatewayState | undefined;
  private servers: http.Server[] = [];
  private self: Self | null = null;
  /** The certificate it serves HTTPS with, in memory only, and when it was asked for. */
  private tls: { domain: string; cert: string; key: string; at: number } | null = null;
  private readonly devices = new Map<string, { device: Device | null; until: number }>();
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private readonly wss = new WebSocketServer({ noServer: true });

  private readonly options: { socketPath: string; uiDir: string; tailscale?: Tailscale; port?: number };

  constructor(options: { socketPath: string; uiDir: string; tailscale?: Tailscale; port?: number }) {
    super();
    this.options = options;
  }

  setEnabled(enabled: boolean) {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (enabled) {
      void this.check();
      this.timer = setInterval(() => void this.check(), CHECK_INTERVAL);
      this.timer.unref();
    } else {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.stop();
      this.update(undefined);
    }
  }

  close() {
    this.setEnabled(false);
    this.wss.close();
  }

  private checking = false;

  /** Listens on this Mac's current Tailscale addresses, again if they changed. */
  private async check() {
    // The first certificate takes longer than the interval.
    if (this.checking) return;
    this.checking = true;
    try {
      await this.checkNow();
    } finally {
      this.checking = false;
    }
  }

  private async checkNow() {
    const tailscale = this.options.tailscale ?? cliTailscale;
    const self = await tailscale.self().catch(() => null);
    if (!this.enabled) return;
    if (!self || self.addresses.length === 0) {
      this.stop();
      this.update({ error: "Tailscale isn't running on this Mac." });
      return;
    }

    // HTTPS once the tailnet has certificates on (DNS → HTTPS Certificates
    // in Tailscale's admin console): a secure page (the clipboard,
    // crypto.randomUUID), and one an https page (the iOS app's) can connect to.
    const renewed = await this.renewCert(self, tailscale);
    if (!this.enabled) return;
    const listening = this.servers.length > 0 && String(self.addresses) === String(this.self?.addresses);
    if (listening && (this.tls?.domain ?? null) === (self.domain ?? null)) {
      if (renewed && this.tls) for (const server of this.servers) (server as https.Server).setSecureContext?.(this.tls);
      return;
    }

    this.stop();
    this.self = self;
    const port = this.options.port ?? GATEWAY_PORT;
    try {
      this.servers = await Promise.all(self.addresses.map((address) => this.listen(address, port)));
      this.update({ url: this.tls ? `https://${this.tls.domain}:${port}/` : `http://${self.name}:${port}/` });
    } catch (error) {
      this.stop();
      this.update({ error: `Couldn't listen on port ${port}: ${error instanceof Error ? error.message : error}` });
    }
  }

  /** Asks for this Mac's certificate when it's due; whether a new one came. */
  private async renewCert(self: Self, tailscale: Tailscale): Promise<boolean> {
    if (!self.domain) {
      this.tls = null;
      return false;
    }
    if (this.tls?.domain === self.domain && Date.now() - this.tls.at < CERT_INTERVAL) return false;
    try {
      const { cert, key } = await tailscale.cert(self.domain);
      const changed = cert !== this.tls?.cert;
      this.tls = { domain: self.domain, cert, key, at: Date.now() };
      return changed;
    } catch {
      // Keep any we had; without one, plain http on the short name.
      if (this.tls?.domain !== self.domain) this.tls = null;
      return false;
    }
  }

  private listen(address: string, port: number): Promise<http.Server> {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => void this.request(req, res);
    const server = this.tls ? https.createServer({ cert: this.tls.cert, key: this.tls.key }, handler) : http.createServer(handler);
    server.on("upgrade", (req, socket, head) => void this.upgrade(req, socket, head));
    server.on("connect", (req, socket, head) => void this.connect(req, socket, head));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, address, () => {
        server.off("error", reject);
        resolve(server);
      });
    });
  }

  private stop() {
    for (const server of this.servers) {
      server.close();
      server.closeAllConnections();
    }
    this.servers = [];
    this.self = null;
    for (const client of this.wss.clients) client.terminate();
  }

  private update(state: GatewayState | undefined) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.emit("change");
  }

  /** Whether a connection comes from one of this Mac's owner's other devices (not this Mac). */
  private async allowed(req: http.IncomingMessage): Promise<boolean> {
    const self = this.self;
    const address = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    if (!self || !address) return false;

    let known = this.devices.get(address);
    if (!known || known.until < Date.now()) {
      const tailscale = this.options.tailscale ?? cliTailscale;
      known = { device: await tailscale.whois(address).catch(() => null), until: Date.now() + OWNER_TTL };
      this.devices.set(address, known);
    }
    return !!known.device && known.device.owner === self.owner && known.device.node !== self.node;
  }

  private async request(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!(await this.allowed(req))) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Only your own devices on Tailscale can open Miks here.");
      return;
    }
    // The panel's browser on a device, going out from this Mac, as `miks
    // browse` does in a Mac's window (Proxy.ts): plain HTTP for a full URL.
    if (isProxyRequest(req)) return proxyRequest(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") return void res.writeHead(405).end();

    const { uiDir } = this.options;
    const pathname = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    const file = path.join(uiDir, pathname === "/" ? "index.html" : path.normalize(pathname));
    if (!file.startsWith(uiDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return void res.writeHead(404).end();
    }

    if (path.basename(file) === "index.html") {
      // The page may open a WebSocket back to wherever it came from.
      const host = /^[\w.:[\]-]+$/.test(req.headers.host ?? "") ? req.headers.host : null;
      let html = fs.readFileSync(file, "utf8");
      if (host) html = html.replace("connect-src 'self'", `connect-src 'self' ws://${host} wss://${host}`);
      // So the page connects back here (ui/webBridge.ts), not to a Mac you named.
      html = html.replace("<head>", `<head>\n    <meta name="miks-gateway" />`);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(html);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  /** And HTTPS and WebSockets, as CONNECT tunnels made from this Mac. */
  private async connect(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    if (!(await this.allowed(req))) return void socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    proxyConnect(req, socket, head);
  }

  /** `/ws`, from the gateway's own page or the app's only, piped to the daemon's socket. */
  private async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    const ownPage = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    const appPage = !!origin && APP_ORIGINS.includes(origin);
    if (req.url !== "/ws" || !(ownPage || appPage) || !(await this.allowed(req))) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }

    this.wss.handleUpgrade(req, socket, head, (device) => {
      const daemon = connectDaemon(this.options.socketPath);
      const early: string[] = [];
      daemon.on("open", () => early.splice(0).forEach((message) => daemon.send(message)));
      daemon.on("message", (data) => device.send(data.toString()));
      daemon.on("close", () => device.close());
      daemon.on("error", () => device.close());
      device.on("message", (data) => {
        if (daemon.readyState === daemon.OPEN) daemon.send(data.toString());
        else early.push(data.toString());
      });
      device.on("close", () => daemon.close());
      device.on("error", () => daemon.close());
    });
  }
}

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

/** Where the Tailscale CLI may be: inside the Mac app, or on its own (Homebrew, the standalone install). */
const CLI_PATHS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

function tailscaleText(args: string[], timeout = 90_000): Promise<string> {
  const cli = CLI_PATHS.find((file) => fs.existsSync(file));
  if (!cli) return Promise.reject(new Error("Tailscale isn't installed."));
  return new Promise((resolve, reject) => {
    // The same executable is the Mac app: without a terminal's TERM (or
    // TERM_PROGRAM, or SHLVL), it tries to start as the app ("The Tailscale
    // GUI failed to start"). The daemon, a launchd job, has none of them.
    const env = { ...process.env, TERM: process.env.TERM || "dumb" };
    execFile(cli, args, { env, timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });
}

async function tailscaleJson(args: string[]): Promise<any> {
  return JSON.parse(await tailscaleText(args, 5000));
}

/** Tailscale, by its CLI, which talks to the Tailscale app running on this Mac. */
export const cliTailscale: Tailscale = {
  async self() {
    const status = await tailscaleJson(["status", "--json"]);
    if (status?.BackendState !== "Running" || !status.Self) return null;
    return {
      addresses: status.Self.TailscaleIPs ?? [],
      // Its MagicDNS name, without the tailnet's suffix: what the others call it.
      name: String(status.Self.DNSName ?? "").split(".")[0] || status.Self.TailscaleIPs?.[0],
      node: String(status.Self.ID),
      owner: String(status.Self.UserID),
      // With HTTPS certificates on for the tailnet, the name one is for.
      domain: (status.CertDomains ?? []).find((domain: string) => domain === String(status.Self.DNSName).replace(/\.$/, "")),
    };
  },
  async whois(address) {
    const whois = await tailscaleJson(["whois", "--json", address]);
    if (!whois?.Node?.StableID || whois.UserProfile?.ID == null) return null;
    return { node: String(whois.Node.StableID), owner: String(whois.UserProfile.ID) };
  },
  // Both to stdout: the CLI is the sandboxed Mac app, which may not write
  // files elsewhere ("operation not permitted"), and it fails on /dev/null
  // ("not a regular file") after printing the other. The first takes half a minute.
  async cert(domain) {
    const text = await tailscaleText(["cert", "--cert-file", "-", "--key-file", "-", domain]);
    const key = text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[^-]+-----END [A-Z ]*PRIVATE KEY-----\n?/)?.[0];
    const cert = key && text.replace(key, "");
    if (!key || !cert?.includes("BEGIN CERTIFICATE")) throw new Error("No certificate from Tailscale.");
    return { cert, key };
  },
};
