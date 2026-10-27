// The Tailscale CLI, for the daemon's gateway (server/Gateway.ts) and for the
// app's windows on other Macs, which connect to theirs (app/remotes.ts).
import { execFile } from "child_process";
import fs from "fs";

/** The port the gateway listens on, on each of a Mac's Tailscale addresses. */
export const GATEWAY_PORT = 2741;

/**
 * The header a program (a Mac's Miks, for its window on this one) sends with
 * the daemon's HTTP API. A web page can't send it to another site without
 * asking first (a CORS preflight, which this never answers), so a page in a
 * browser on your own devices can't use the API, as it can't the WebSocket.
 */
export const API_HEADER = "x-miks-client";

/** Where the Tailscale CLI may be: inside the Mac app, or on its own (Homebrew, the standalone install). */
const CLI_PATHS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"];

export function tailscaleText(args: string[], timeout = 90_000): Promise<string> {
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

export async function tailscaleJson(args: string[]): Promise<any> {
  return JSON.parse(await tailscaleText(args, 5000));
}

/** Another Mac on the tailnet, as `tailscale status` lists it. */
export type TailnetMac = {
  /** Its MagicDNS name, without the tailnet's suffix: what Miks calls it. */
  name: string;
  /** Its full name, which its certificate is for, if any. */
  domain: string;
  addresses: string[];
  online: boolean;
  /** Whether it's signed in as the same user as this Mac (only then does its gateway let this Mac in). */
  mine: boolean;
};

/**
 * The other Macs on this Mac's tailnet. Throws, saying why, when there's no
 * tailnet to ask: Tailscale not installed, or not running.
 */
export async function tailnetMacs(): Promise<TailnetMac[]> {
  let status: any;
  try {
    status = await tailscaleJson(["status", "--json"]);
  } catch (error) {
    throw new Error(error instanceof Error && /isn't installed/.test(error.message) ? error.message : "Tailscale isn't running on this Mac.");
  }
  if (status?.BackendState !== "Running" || !status.Self) throw new Error("Tailscale isn't running on this Mac.");
  return Object.values<any>(status.Peer ?? {})
    .filter((peer) => peer.OS === "macOS")
    .map((peer) => {
      const domain = String(peer.DNSName ?? "").replace(/\.$/, "");
      return {
        name: domain.split(".")[0] || String(peer.HostName),
        domain,
        addresses: peer.TailscaleIPs ?? [],
        online: !!peer.Online,
        mine: String(peer.UserID) === String(status.Self.UserID),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
