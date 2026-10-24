import { execFile, spawn } from "child_process";
import dns from "dns";
import fs from "fs";
import http from "http";
import https from "https";
import net from "net";
import os from "os";
import path from "path";
import type { FileProblem } from "../shared/protocol.ts";

/** The most the panel opens: past this it's a log or a dump, not a file to edit. */
const MAX_SIZE = 5 * 1024 * 1024;

/** What the panel shows of a file: its text, or why there's none to show. */
export type FileContents = { content: string | null; mtime: number | null; problem?: FileProblem };

/** A file for the panel. One that isn't there yet is empty, with no mtime. */
export async function readForPanel(file: string): Promise<FileContents> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { content: "", mtime: null };
    return { content: null, mtime: null, problem: "unreadable" };
  }
  if (!stat.isFile()) return { content: null, mtime: stat.mtimeMs, problem: "unreadable" };
  if (stat.size > MAX_SIZE) return { content: null, mtime: stat.mtimeMs, problem: "large" };

  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return { content: null, mtime: stat.mtimeMs, problem: "unreadable" };
  }
  // A NUL byte early on is as good a sign of binary as any (git uses it).
  if (data.subarray(0, 8000).includes(0)) return { content: null, mtime: stat.mtimeMs, problem: "binary" };
  return { content: data.toString("utf8"), mtime: stat.mtimeMs };
}

/**
 * Saves a file from the panel, in place (keeping its permissions and any
 * hard links), unless it changed on disk since the editor's copy: then it's
 * left alone and `changed` says so, for the editor to ask.
 */
export async function writeFromPanel(
  file: string,
  content: string,
  mtime: number | null,
  force = false,
): Promise<{ mtime?: number; changed?: boolean; error?: string }> {
  if (!force) {
    const current = await fs.promises.stat(file).then(
      (stat) => stat.mtimeMs,
      () => null,
    );
    if (current !== mtime) return { changed: true };
  }

  try {
    await fs.promises.writeFile(file, content);
    return { mtime: (await fs.promises.stat(file)).mtimeMs };
  } catch (error: any) {
    return { error: String(error?.message ?? error) };
  }
}

/** The most a markdown file's image can be: they go to the window base64. */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** What a markdown file in the panel can show as an image, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/**
 * An image for a markdown file in the panel, base64. Only images, by the
 * extension of the file itself, not of a link to it: a file's
 * `![](~/.ssh/id_ed25519)` gets nothing, nor does a `logo.png` linked to it.
 * With `known`, the mtime of the copy the window has: the same, and it's
 * `unchanged` rather than read again.
 */
export async function readImageForPanel(
  file: string,
  known?: number,
): Promise<{ data?: string; mime?: string; mtime?: number; unchanged?: boolean; error?: string }> {
  try {
    const real = await fs.promises.realpath(file);
    const mime = IMAGE_TYPES[real.split(".").pop()?.toLowerCase() ?? ""];
    if (!mime) return { error: "Not an image." };

    const stat = await fs.promises.stat(real);
    if (!stat.isFile()) return { error: "Not a file." };
    if (stat.mtimeMs === known) return { mtime: known, unchanged: true };
    if (stat.size > MAX_IMAGE_SIZE) return { error: "Too big to show (over 10 MB)." };
    return { data: (await fs.promises.readFile(real)).toString("base64"), mime, mtime: stat.mtimeMs };
  } catch (error: any) {
    return { error: error?.code === "ENOENT" ? "No such file." : "Can't be read." };
  }
}

/**
 * Shows a folder in Finder on this Mac: opens it, or for a bundle (an app,
 * a `.rtfd`), which opening would start or open as a document, shows it in
 * its own folder.
 */
export async function showFolder(folder: string) {
  try {
    const real = await fs.promises.realpath(folder);
    if (!(await fs.promises.stat(real)).isDirectory()) return;
    const args = (await isPackage(real)) ? ["-R", real] : [real];
    spawn("open", args, { stdio: "ignore" }).on("error", () => {});
  } catch {
    // Gone since it was found.
  }
}

/** Whether macOS takes a folder as one thing, as Finder does. Failing to tell, it's taken as one: showing it is the safe way round. */
function isPackage(folder: string): Promise<boolean> {
  // Not without an extension (lodash.merge has one, but isn't).
  if (!path.extname(folder)) return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile("osascript", ["-l", "JavaScript", "-e", IS_PACKAGE, folder], (error, stdout) => resolve(!!error || stdout.trim() !== "false"));
  });
}

const IS_PACKAGE = 'ObjC.import("AppKit"); function run(argv) { return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath($(argv[0])); }';

/**
 * Paths as a terminal shows them, found on disk: relative to `cwd`, `~` the
 * home folder, and with any `:line` or `:line:column` after a file's name
 * (compilers', and Claude Code's, way of pointing into it) left off.
 */
export async function findPaths(paths: string[], cwd: string | null): Promise<({ path: string; folder: boolean } | null)[]> {
  const find = async (written: string) => {
    const expanded = written === "~" || written.startsWith("~/") ? os.homedir() + written.slice(1) : written;
    if (!path.isAbsolute(expanded) && !cwd) return null;
    const absolute = path.resolve(cwd ?? "/", expanded);
    try {
      const stat = await fs.promises.stat(absolute);
      return stat.isDirectory() || stat.isFile() ? { path: absolute, folder: stat.isDirectory() } : null;
    } catch {
      return null;
    }
  };
  return Promise.all(
    paths.map(async (written) => {
      const found = await find(written);
      if (found) return found;
      const bare = written.replace(/(:\d+){1,2}$/, "");
      return bare !== written ? find(bare) : null;
    }),
  );
}

/**
 * An image from the web for a markdown file in the panel, base64, fetched
 * here so a remote window's comes from the daemon's Mac as its files do.
 * Only once you've said to (the panel asks), only images, and never from
 * this Mac or its network: a file's image could otherwise poke at what
 * listens there. Redirects are followed here, each one checked again.
 */
export function fetchImageForPanel(
  url: string,
  redirects = 5,
  deadline = Date.now() + 15_000,
): Promise<{ data?: string; mime?: string; error?: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Promise.resolve({ error: "Not a web address." });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return Promise.resolve({ error: "Not a web address." });
  // An address, not a name, never goes through `lookup`.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host) && isLocalAddress(host)) return Promise.resolve({ error: LOCAL });

  return new Promise((resolve) => {
    const get = parsed.protocol === "https:" ? https.get : http.get;
    // All of it, redirects too, in the time: a server can send slowly forever.
    const signal = AbortSignal.timeout(Math.max(0, deadline - Date.now()));
    const request = get(parsed, { lookup: publicLookup, signal }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (redirects === 0) return resolve({ error: "Too many redirects." });
        // A Location that isn't a URL mustn't throw here, which would end the daemon.
        let next: string;
        try {
          next = new URL(location, parsed).href;
        } catch {
          return resolve({ error: "Couldn't be loaded." });
        }
        return resolve(fetchImageForPanel(next, redirects - 1, deadline));
      }
      if (status < 200 || status >= 300) {
        response.resume();
        return resolve({ error: `The server answered ${status}.` });
      }
      const mime = response.headers["content-type"]?.split(";")[0].trim().toLowerCase() ?? "";
      if (!mime.startsWith("image/")) {
        response.destroy();
        return resolve({ error: "Not an image." });
      }

      // Read until it's too big, rather than trusting its Content-Length.
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_IMAGE_SIZE) return void chunks.push(chunk);
        response.destroy();
        resolve({ error: "Too big to show (over 10 MB)." });
      });
      response.on("end", () => resolve({ data: Buffer.concat(chunks).toString("base64"), mime }));
      response.on("error", () => resolve({ error: "Couldn't be loaded." }));
      // Cut off (the deadline) before its end; after it, this changes nothing.
      response.on("close", () => resolve({ error: "Couldn't be loaded." }));
    });
    request.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code === "ELOCAL" ? LOCAL : "Couldn't be loaded." }));
  });
}

const LOCAL = "On this Mac or its network, which a file's images can't reach.";

/**
 * dns.lookup, refusing a name that leads to this Mac or its network. As the
 * connection's own lookup, so the address checked is the one connected to
 * (a name can't change its answer in between).
 */
function publicLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
) {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (addresses.length === 0 || addresses.some(({ address }) => isLocalAddress(address))) {
      return callback(Object.assign(new Error(LOCAL), { code: "ELOCAL" }), []);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * Loopback, private, link-local, shared (CGNAT), multicast, reserved or
 * unspecified: not the internet. An IPv4 address inside an IPv6 one
 * (mapped, compatible, NAT64, 6to4) is checked as itself.
 */
function isLocalAddress(address: string): boolean {
  const networks = macNetworks();
  const localV4Address = (v4: string) => localV4.check(v4, "ipv4") || networks.check(v4, "ipv4");
  if (net.isIPv4(address)) return localV4Address(address);
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const zero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);
  const v4At = (at: number) => bytes.slice(at, at + 4).join(".");
  const mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  if (zero(0, 10) && (mapped || zero(10, 12))) return localV4Address(v4At(12));
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) return localV4Address(v4At(12));
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return localV4Address(v4At(2));
  return localV6.check(address, "ipv6") || networks.check(address, "ipv6");
}

/**
 * This Mac's own addresses and the networks they're on, public ones too
 * (an IPv6 /64 is usually public): looked up each time, as they change
 * with Wi-Fi and VPNs. A network wider than a /16 (IPv4) or /48 (IPv6)
 * is taken as the address alone, so an odd one can't refuse the internet.
 */
function macNetworks(): net.BlockList {
  const networks = new net.BlockList();
  for (const address of Object.values(os.networkInterfaces()).flat()) {
    if (!address) continue;
    const family = address.family === "IPv4" ? "ipv4" : "ipv6";
    const prefix = Number(address.cidr?.split("/")[1] ?? (family === "ipv4" ? 32 : 128));
    const network = family === "ipv4" ? (prefix >= 16 ? prefix : 32) : prefix >= 48 ? prefix : 128;
    networks.addSubnet(address.address.split("%")[0], network, family);
  }
  return networks;
}

/** An IPv6 address's 16 bytes (a dotted IPv4 end too), or null if it isn't one. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.toLowerCase().split("%")[0];
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = text.slice(0, -dotted[0].length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const groups = halves.length === 2 ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
  if (groups.length !== 8 || !groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.flatMap((group) => [parseInt(group, 16) >> 8, parseInt(group, 16) & 0xff]);
}

const localV4 = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  localV4.addSubnet(network, prefix, "ipv4");
}

// Those with an IPv4 address inside are checked as it, above.
const localV6 = new net.BlockList();
for (const [network, prefix] of [
  ["64:ff9b:1::", 48],
  ["2001::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  localV6.addSubnet(network, prefix, "ipv6");
}
