// What `miks version` (server/Version.ts) and the UI's VersionDialog both
// say about a VersionInfo, so the two read the same.
import type { ClientInfo, VersionInfo } from "./protocol.ts";

/** What a window is: "Miks.app", "iOS app 1.0 (7)". */
export const clientKind = ({ kind, ui, app }: ClientInfo) =>
  kind === "mac" ? (ui.dev ? "Miks dev build" : "Miks.app") : kind === "browser" ? "A browser" : `iOS app${app ? ` ${app.version} (${app.build})` : ""}`;

/** What its UI's build is called: a Mac's is Miks itself, a device's the web bundle it loaded. */
export const buildLabel = (client: ClientInfo) => (client.kind === "mac" ? "Miks" : "Web bundle");

/** What else to say about a window, on the daemon's `machine`. */
export const windowNotes = (client: ClientInfo, machine: string) =>
  [client.kind === "mac" && client.machine !== machine && "a window on another Mac", client.watching && "watching in the background"].filter(
    (note): note is string => !!note,
  );

/** Whether what's installed isn't what the daemon runs. */
export const installedChanged = ({ installed, running }: VersionInfo) =>
  installed.version !== running.version || installed.commit !== running.commit;

/** Whether a Miks window on the daemon's own Mac is connected. */
export const windowHere = ({ windows, machine }: VersionInfo) => windows.some((w) => w.client?.kind === "mac" && w.client.machine === machine);

/** How long ago, roughly. */
export function ago(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
