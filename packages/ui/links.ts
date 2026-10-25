import { daemon } from "./daemon";

/** A link to the machine itself, in some spelling. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Opens a link from a tab (its terminal, chat or page). In the iOS app, one
 * to localhost (a dev server, say) means the Mac's, which only Miks can reach
 * (Pages.swift), so it opens in a new tab after this one, its page filling it;
 * anything else, in the browser (in Miks on a Mac, the one Settings chose).
 * The app's web view opens no windows, so there it's the app that opens it
 * (the shell's `openUrl`, as crosswing's ipc sends it): `window.open` did
 * nothing, and only holding a link, for WebKit's own menu, worked.
 */
export function openLink(url: string, tabId: string) {
  if (window.miks?.pages && isLoopback(url)) {
    const workspace = daemon.getSnapshot().state?.workspaces.find((workspace) => workspace.tabs.some((tab) => tab.id === tabId));
    if (workspace) return daemon.send({ type: "createTab", workspaceId: workspace.id, url });
  }
  const app = (window as any).webkit?.messageHandlers?.default;
  if (app) app.postMessage({ name: "openUrl", url });
  else window.open(url);
}
