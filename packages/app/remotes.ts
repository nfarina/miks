// Windows on another Mac reach its daemon through its gateway on Tailscale
// (daemon/server/Gateway.ts), as the iOS app does: on with Settings →
// Remotes → Access from your other devices there, and letting in only your
// own devices. Here, each remote gets a local Unix socket that pipes every
// connection to that gateway, over TLS when it has a certificate, so the
// rest of Miks talks to a remote's daemon just as to this Mac's: WebSocket,
// HTTP API (with `API_HEADER`) and the page proxy alike.
import fs from "fs";
import http from "http";
import net from "net";
import path from "path";
import tls from "tls";
import { miksHome } from "miks/shared/paths";
import type { Remote } from "miks/shared/settings";
import { API_HEADER, GATEWAY_PORT, tailnetMacs } from "miks/shared/tailscale";

/** Where a remote's gateway is: an address, the name its certificate is for, and whether it has one. */
type Target = { address: string; domain: string; port: number; secure?: boolean };

type Link = {
  server: net.Server;
  socket: string;
  host: string;
  target: Target | null;
  at: number;
  /** Why the last connection to it failed, for `checkRemote` to explain. */
  error?: string;
};

/** How long a remote's address is trusted before Tailscale is asked again (and after any failure, it is). */
const TARGET_TTL = 60_000;

const links = new Map<string, Link>();

/** The local end of a remote's link, starting it if needed. */
export async function remoteSocket(remote: Remote): Promise<string> {
  const existing = links.get(remote.id);
  if (existing?.host === remote.host && existing.server.listening) return existing.socket;
  stopRemote(remote.id);

  // Short, since macOS caps socket paths at 104 bytes.
  const socket = path.join(miksHome(), "remotes", `${remote.id}.sock`);
  fs.mkdirSync(path.dirname(socket), { recursive: true, mode: 0o700 });
  fs.rmSync(socket, { force: true });

  const link: Link = { server: net.createServer(), socket, host: remote.host, target: null, at: 0 };
  link.server.on("connection", (local) => void forward(link, remote, local));
  links.set(remote.id, link);
  await new Promise<void>((resolve, reject) => {
    link.server.once("error", reject);
    link.server.listen(socket, () => resolve());
  });
  fs.chmodSync(socket, 0o600);
  return socket;
}

export function stopRemote(id: string) {
  const link = links.get(id);
  links.delete(id);
  link?.server.close();
}

export function stopAllRemotes() {
  for (const id of [...links.keys()]) stopRemote(id);
}

/**
 * Whether a remote's daemon can be reached, or why not, in terms of what to
 * do about it.
 */
export async function checkRemote(remote: Remote): Promise<void> {
  const socket = await remoteSocket(remote);
  const link = links.get(remote.id)!;
  // Finds it on the tailnet first: Tailscale says why it can't better than a connection does.
  await target(link, remote);
  const status = await new Promise<number | string>((resolve) => {
    const request = http.request({ socketPath: socket, path: "/api/ping", headers: { [API_HEADER]: "1" }, timeout: 10_000 }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", (error: NodeJS.ErrnoException) => resolve(link.error ?? error.code ?? error.message));
    request.end();
  });
  link.error = undefined;
  if (status === 200) return;

  const name = remote.name || remote.host;
  if (status === 403) throw new Error(`${name} didn't let this Mac in. Both have to be signed in to Tailscale as you.`);
  if (status === 404) throw new Error(`Miks on ${name} is too old for a window from here. Update it there, and restart its daemon.`);
  // The gateway is the daemon's, so nothing listening is either.
  if (status === "ECONNREFUSED" || status === 502) {
    throw new Error(`Miks on ${name} isn't letting your other devices in. Open it there, with Settings → Remotes → Access from your other devices on.`);
  }
  if (status === "timeout" || status === "ETIMEDOUT" || status === "EHOSTUNREACH") throw new Error(`Couldn't reach ${name}. Is it awake?`);
  throw new Error(`Couldn't connect to ${name} (${status}).`);
}

/** One connection from this Mac, piped to the remote's gateway. */
async function forward(link: Link, remote: Remote, local: net.Socket) {
  local.on("error", () => {});
  let upstream: net.Socket;
  try {
    upstream = await connect(await target(link, remote));
  } catch (error) {
    link.target = null;
    link.error = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    return void local.destroy();
  }
  if (local.destroyed) return void upstream.destroy();
  upstream.on("error", () => local.destroy());
  local.on("close", () => upstream.destroy());
  upstream.on("close", () => local.destroy());
  local.pipe(upstream).pipe(local);
}

/**
 * The gateway as TLS to its full name when it has a certificate, else plain
 * TCP (still encrypted, by WireGuard); found out once, by trying TLS.
 */
function connect(target: Target): Promise<net.Socket> {
  const plain = () =>
    new Promise<net.Socket>((resolve, reject) => {
      const socket = net.connect(target.port, target.address);
      socket.once("connect", () => (socket.off("error", reject), resolve(socket)));
      socket.once("error", reject);
    });
  if (target.secure === false) return plain();

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.address, port: target.port, servername: target.domain });
    socket.once("secureConnect", () => {
      socket.off("error", failed);
      target.secure = true;
      resolve(socket);
    });
    const failed = (error: NodeJS.ErrnoException) => {
      // A gateway without a certificate answers TLS with plain HTTP's 400.
      if (target.secure === undefined && /wrong version number|packet length too long|ECONNRESET/i.test(`${error.code} ${error.message}`)) {
        target.secure = false;
        return void plain().then(resolve, reject);
      }
      reject(error);
    };
    socket.once("error", failed);
  });
}

/**
 * Where a remote's gateway is. Its host is its name on the tailnet (`neo`),
 * or a full name or address as it is; either with `:port` for another port
 * (testing).
 */
async function target(link: Link, remote: Remote): Promise<Target> {
  if (link.target && Date.now() - link.at < TARGET_TTL) return link.target;
  const [, host, port] = /^(.*?)(?::(\d+))?$/.exec(remote.host.trim())!;
  const portNumber = Number(port) || GATEWAY_PORT;
  let found: Target;
  if (host.includes(".") || host.includes(":")) {
    found = { address: host, domain: host, port: portNumber };
  } else {
    const mac = (await tailnetMacs()).find((entry) => entry.name.toLowerCase() === host.toLowerCase());
    const name = remote.name || host;
    if (!mac) throw new Error(`There's no Mac called “${host}” on your tailnet.`);
    if (!mac.online) throw new Error(`${name} is offline on Tailscale. Is it awake?`);
    found = { address: mac.addresses[0], domain: mac.domain, port: portNumber };
  }
  // What it found out about TLS last time, if it's the same place.
  if (link.target?.address === found.address && link.target.port === found.port) found.secure = link.target.secure;
  link.target = found;
  link.at = Date.now();
  return found;
}
