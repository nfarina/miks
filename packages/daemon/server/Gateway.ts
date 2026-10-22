import { execFile } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import http from "http";
import type { Duplex } from "stream";
import path from "path";
import { WebSocketServer } from "ws";
import { connectDaemon } from "../shared/connect.ts";
import type { GatewayState } from "../shared/protocol.ts";

/** The port on each of this Mac's Tailscale addresses. */
export const GATEWAY_PORT = 2741;

/** How often a listening gateway checks its addresses (and one that failed tries again). */
const CHECK_INTERVAL = 30_000;

/** How long who's at an address is remembered. */
const OWNER_TTL = 60_000;

/** A device on the tailnet: which one (its stable ID), and the user it's signed in as. */
type Device = { node: string; owner: string };

/** What the gateway asks Tailscale: this Mac on the tailnet, and who's at an address. */
export type Tailscale = {
  /** This Mac, or null when Tailscale isn't running (or isn't installed). */
  self(): Promise<(Device & { addresses: string[]; name: string }) | null>;
  /** The device at an address, or null for one that isn't on the tailnet. */
  whois(address: string): Promise<Device | null>;
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
  private self: (Device & { addresses: string[]; name: string }) | null = null;
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

  /** Listens on this Mac's current Tailscale addresses, again if they changed. */
  private async check() {
    const tailscale = this.options.tailscale ?? cliTailscale;
    const self = await tailscale.self().catch(() => null);
    if (!this.enabled) return;
    if (!self || self.addresses.length === 0) {
      this.stop();
      this.update({ error: "Tailscale isn't running on this Mac." });
      return;
    }
    if (this.servers.length > 0 && String(self.addresses) === String(this.self?.addresses)) return;

    this.stop();
    this.self = self;
    const port = this.options.port ?? GATEWAY_PORT;
    try {
      this.servers = await Promise.all(self.addresses.map((address) => this.listen(address, port)));
      this.update({ url: `http://${self.name}:${port}/` });
    } catch (error) {
      this.stop();
      this.update({ error: `Couldn't listen on port ${port}: ${error instanceof Error ? error.message : error}` });
    }
  }

  private listen(address: string, port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => void this.request(req, res));
    server.on("upgrade", (req, socket, head) => void this.upgrade(req, socket, head));
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
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(html);
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  }

  /** `/ws`, from the gateway's own page only, piped to the daemon's socket. */
  private async upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const origin = req.headers.origin;
    const ownPage = origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
    if (req.url !== "/ws" || !ownPage || !(await this.allowed(req))) {
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

function tailscaleJson(args: string[]): Promise<any> {
  const cli = CLI_PATHS.find((file) => fs.existsSync(file));
  if (!cli) return Promise.reject(new Error("Tailscale isn't installed."));
  return new Promise((resolve, reject) => {
    // The same executable is the Mac app: without a terminal's TERM (or
    // TERM_PROGRAM, or SHLVL), it tries to start as the app ("The Tailscale
    // GUI failed to start"). The daemon, a launchd job, has none of them.
    const env = { ...process.env, TERM: process.env.TERM || "dumb" };
    execFile(cli, args, { env, timeout: 5000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

/** Tailscale, by its CLI, which talks to the Tailscale app running on this Mac. */
const cliTailscale: Tailscale = {
  async self() {
    const status = await tailscaleJson(["status", "--json"]);
    if (status?.BackendState !== "Running" || !status.Self) return null;
    return {
      addresses: status.Self.TailscaleIPs ?? [],
      // Its MagicDNS name, without the tailnet's suffix: what the others call it.
      name: String(status.Self.DNSName ?? "").split(".")[0] || status.Self.TailscaleIPs?.[0],
      node: String(status.Self.ID),
      owner: String(status.Self.UserID),
    };
  },
  async whois(address) {
    const whois = await tailscaleJson(["whois", "--json", address]);
    if (!whois?.Node?.StableID || whois.UserProfile?.ID == null) return null;
    return { node: String(whois.Node.StableID), owner: String(whois.UserProfile.ID) };
  },
};
