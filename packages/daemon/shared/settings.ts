// The app's preferences, kept by the Electron main process in settings.json
// and shared by every window (packages/app/main.ts).

/** Another Mac whose daemon Miks can open a window on, over SSH. */
export type Remote = {
  id: string;
  /** What the window's badge says. */
  name: string;
  /** What `ssh` connects to: a host, or a Host from ~/.ssh/config. */
  host: string;
  /** The badge's color, as CSS. */
  color: string;
};

export type Settings = {
  /** Terminal text size, in points. */
  fontSize: number;
  /** A path prefix (like `~/Code/`) the sidebar leaves off directories. */
  hidePathPrefix: string;
  /** Whether to notify when an agent finishes or needs you. */
  notifications: boolean;
  /** Whether the sidebar is showing (⌘B). */
  sidebarVisible: boolean;
  /** Whether a long reply opens the chat panel when it's done. */
  chatForLongReplies: boolean;
  /** Whether the daemon, and every terminal, outlives quitting the app. */
  keepDaemonRunning: boolean;
  /** Whether Miks keeps its hooks in Claude Code's settings, for agent status. */
  claudeHooks: boolean;
  /** Whether Option sends Meta (⌥A as Escape-A, for zsh bindings) instead of typing å. */
  optionAsMeta: boolean;
  /**
   * What opens links (from terminals, chat, and pages that open a new
   * window): "" for the default browser, else an app's bundle ID, or its
   * path (starting with "/") for one chosen in Settings.
   */
  browser: string;
  remotes: Remote[];
  /** Whether your other devices on Tailscale can open Miks in a browser (the daemon's gateway). */
  tailnetAccess: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  hidePathPrefix: "",
  notifications: true,
  sidebarVisible: true,
  chatForLongReplies: true,
  keepDaemonRunning: false,
  claudeHooks: true,
  optionAsMeta: true,
  browser: "",
  remotes: [],
  tailnetAccess: false,
};

/**
 * A directory for display: the home folder as `~`, and the "hide path
 * prefix" setting left off (`~/Code/sage` with `~/Code/` hidden is `sage`).
 */
export function displayPath(cwd: string, hidePrefix: string, home: string | null): string {
  const tilde = (p: string) => (home && (p === home || p.startsWith(home + "/")) ? "~" + p.slice(home.length) : p);
  const shown = tilde(cwd);

  const prefix = tilde(hidePrefix.trim()).replace(/\/+$/, "");
  if (!prefix) return shown;
  return shown.startsWith(prefix + "/") ? shown.slice(prefix.length + 1) : shown;
}
