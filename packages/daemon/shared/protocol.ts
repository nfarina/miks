// The wire contract between the daemon and its clients. Clients talk to the
// daemon over a WebSocket on its Unix socket, one JSON message per frame.
// This file is the only edge between the daemon and the UI.

/**
 * Bumped when a message changes shape or appears, so a UI talking to another
 * Mac's daemon can tell it's a different Miks. Before 2 there was none.
 */
export const PROTOCOL_VERSION = 10;

/**
 * What a coding agent in a pane is up to, as reported by its hooks.
 *
 * - `working`: busy on a prompt.
 * - `waiting`: blocked on you (a permission prompt, a question).
 * - `done`: finished a turn you haven't looked at yet.
 * - `idle`: running, nothing new.
 */
export type AgentStatus = "working" | "waiting" | "done" | "idle";

export type AgentState = {
  kind: "claude";
  status: AgentStatus;
  /** The agent's own words for why it's waiting, when it gave any. */
  message?: string;
  /** Epoch milliseconds of the last status change. */
  since: number;
  /** How many lines the turn that just ended replied with. Since protocol 5. */
  replyLines?: number;
  /** The start of that reply, as written (markdown), for a notification. */
  reply?: string;
};

/**
 * One thing in a tab's Claude Code conversation, as the chat panel shows it,
 * read from the session's transcript. Since protocol 5.
 *
 * - `prompt`: what you sent.
 * - `reply`: Claude's text, as markdown.
 * - `tool`: a tool call: its name, a line saying what it did, and, when
 *   there's more to it, the details (a command, an edit).
 */
export type ChatEntry =
  | { id: string; kind: "prompt"; text: string; time: number }
  | { id: string; kind: "reply"; text: string; time: number }
  | { id: string; kind: "tool"; name: string; summary: string; detail?: string; time: number };

export type Tab = {
  /** Also the pane's id; a tab holds exactly one pane for now. */
  id: string;
  /**
   * The same tab across daemon restarts, unlike `id` (a new pane each
   * time): for what the UI keeps about a tab, like its chat draft. Since
   * protocol 6.
   */
  key?: string;
  /** The title the program set (OSC 0/2), or the shell's name. */
  title: string;
  /** Where the tab's shell is, checked every couple of seconds. */
  cwd: string | null;
  agent: AgentState | null;
  /** The program in front of the tab's shell, which closing it would stop; missing before protocol 2. */
  running?: string | null;
  /** Whether a restore brings back what's running (`miks keep`, or a Claude session). Since protocol 3. */
  kept?: boolean;
  /** A file shown in the tab's panel (`miks open`, `miks edit`): the latest of `files`. Since protocol 8. */
  file?: OpenFile;
  /** Every file open in the tab's panel, in the order they opened. Since protocol 10. */
  files?: OpenFile[];
  /** A page `miks browse` put in the tab's panel. */
  page?: OpenPage;
  /** What its Claude session has running in the background, while anything is. */
  background?: Background;
};

/** A Claude Code session's background work, as its own footer counts it ("1 shell, 1 monitor"). */
export type Background = { shells: number; monitors: number; agents: number };

/** A file `miks open` or `miks edit` put in a tab's panel. */
export type OpenFile = {
  /** This opening of it: opening it again is another. */
  id: string;
  /** Absolute, on the daemon's Mac. */
  path: string;
  /** Opened for editing (`miks edit`), not just to read. */
  edit: boolean;
  /** Something's waiting for it to close (`miks edit --wait`, as $EDITOR). */
  wait: boolean;
  /** Goes up each time it's opened again while open, which brings it to the front. Since protocol 10. */
  opened?: number;
};

/** Why a file's contents aren't there to show. */
/**
 * A web page `miks browse` put in a tab's panel, loaded through the daemon
 * (its Mac's `localhost`, DNS and network), wherever the window is.
 */
export type OpenPage = {
  /** This opening of it: browsing again, even to the same URL, is another. */
  id: string;
  url: string;
};

export type FileProblem = "binary" | "large" | "unreadable";

export type Workspace = {
  id: string;
  /** A name you gave it, or null to go by its active tab's title. */
  title: string | null;
  cwd: string;
  tabs: Tab[];
  activeTabId: string | null;
};

export type DaemonState = {
  /** The daemon's PROTOCOL_VERSION; missing before 2. */
  protocol?: number;
  /** The daemon's home directory, for showing paths with `~`. */
  home: string;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  /** Its gateway for your other devices on Tailscale, while it's turned on. */
  gateway?: GatewayState;
};

/** Where your other devices open Miks (a browser, on Tailscale), or why they can't. */
export type GatewayState = { url: string } | { error: string };

/**
 * Something macOS lets programs in the daemon's terminals do, once asked
 * (`ask`: a dialog, the first time one tries) or once switched on in System
 * Settings (`settings`). Since protocol 7.
 */
export type Permission = {
  id: string;
  name: string;
  detail: string;
  kind: "ask" | "settings";
  /** For `settings`, `denied` and `notAsked` both mean it's off. */
  status: PermissionStatus;
  /** Being asked for right now (a dialog up, waiting on you). */
  asking: boolean;
};

export type PermissionStatus = "granted" | "denied" | "notAsked" | "unknown";

//
// Client → daemon.
//

export type ClientMessage =
  /** Asks for the full state; the daemon answers with `state`. */
  | { type: "hello" }
  | { type: "createWorkspace"; cwd?: string; title?: string }
  | { type: "closeWorkspace"; workspaceId: string }
  /** An empty title goes back to following the active tab. */
  | { type: "renameWorkspace"; workspaceId: string; title: string }
  | { type: "createTab"; workspaceId: string }
  /** Closes the tab's page (`miks browse`). */
  | { type: "closePage"; tabId: string }
  /** Where the tab's page has gone, to restore it there. */
  | { type: "pageNavigated"; tabId: string; url: string }
  /** Moves a workspace to a position in the sidebar (counted without it). */
  | { type: "moveWorkspace"; workspaceId: string; index: number }
  /** Moves a tab to a position in its workspace's tab bar (counted without it). */
  | { type: "moveTab"; tabId: string; index: number }
  /** The UI's light or dark appearance, for programs that follow it. */
  | { type: "appearance"; dark: boolean }
  | { type: "closeTab"; tabId: string }
  /** Selecting a tab also marks its agent's `done` as seen. */
  | { type: "select"; workspaceId: string; tabId?: string }
  /** The tab is on screen in a focused window, so its `done` has been seen. */
  | { type: "seen"; tabId: string }
  /**
   * Starts streaming a pane: one `snapshot`, then `output` from exactly where
   * it left off. With a size, the pane is resized first; without one (a tab
   * that isn't on screen), it keeps its size and the snapshot reports it.
   */
  | { type: "attach"; tabId: string; cols?: number; rows?: number }
  | { type: "detach"; tabId: string }
  /**
   * Starts sending the tab's Claude Code conversation: one `chat` with all of
   * it, then a `chat` with each new entry. Since protocol 5.
   */
  | { type: "watchChat"; tabId: string }
  | { type: "unwatchChat"; tabId: string }
  /**
   * From the Mac's own Miks: true when it quit while a window on another Mac
   * still had the daemon, which then stops once the last window goes; false
   * when it's back, taking the daemon over again. Since protocol 3.
   */
  | { type: "stopWhenIdle"; value: boolean }
  /** The UI cleared its terminal (⌘K); the daemon's copy follows. */
  | { type: "clear"; tabId: string }
  | { type: "input"; tabId: string; data: string }
  | { type: "resize"; tabId: string; cols: number; rows: number }
  /** Asks how the permissions stand; the daemon answers with `permissions`. Since protocol 7. */
  | { type: "permissions" }
  /**
   * Asks macOS for one, in a dialog on the daemon's Mac, or opens its pane in
   * System Settings there; `permissions` follows as it changes. Since protocol 7.
   */
  | { type: "requestPermission"; id: string }
  /**
   * Starts sending one of the tab's open files (`fileId`, or else `Tab.file`):
   * a `file` now, and another whenever it changes on disk. Since protocol 8;
   * `fileId` since 10.
   */
  | { type: "watchFile"; tabId: string; fileId?: string }
  | { type: "unwatchFile"; tabId: string; fileId?: string }
  /**
   * Writes one of the tab's open files; answered by `fileSaved`. Refused if it
   * changed on disk since `mtime` (what the editor last read or saved; null
   * for a new file), unless `force`.
   */
  | { type: "saveFile"; tabId: string; fileId?: string; content: string; mtime: number | null; force?: boolean }
  /** Closes one of the tab's files, letting a `miks edit --wait` on it go. */
  | { type: "closeFile"; tabId: string; fileId?: string }
  /**
   * Shows another file in the tab's panel, read-only, as `miks open` does: a
   * link in a markdown file. `path` is absolute, on the daemon's Mac. Since
   * protocol 10.
   */
  | { type: "openFile"; tabId: string; path: string }
  /**
   * Reads an image a markdown file in a panel shows (`path` absolute, on the
   * daemon's Mac, and an image by its extension); answered by `image` with
   * the same `requestId`. Since protocol 10.
   */
  | { type: "readImage"; requestId: string; path: string }
  /**
   * Fetches an image from the web (http or https) for a markdown file in a
   * panel, from the daemon's Mac, once you've said to show them; answered
   * by `image` with the same `requestId`. Since protocol 10.
   */
  | { type: "fetchImage"; requestId: string; url: string }
  /**
   * Which of these, as written in the tab's terminal, are there on the
   * daemon's Mac: relative to the tab's folder, `~` its home, and any
   * `:line:column` left off. Answered by `paths`. Since protocol 10.
   */
  | { type: "findPaths"; requestId: string; tabId: string; paths: string[] }
  /** Shows a folder (absolute) in Finder, on the daemon's Mac. Since protocol 10. */
  | { type: "showFolder"; path: string };

//
// Daemon → client.
//

export type DaemonMessage =
  | { type: "state"; state: DaemonState }
  /** The pane's screen and scrollback as VT sequences, to write into a fresh terminal. */
  | { type: "snapshot"; tabId: string; data: string; cols: number; rows: number }
  | { type: "output"; tabId: string; data: string }
  /**
   * The pane took another window's size (on another Mac or device, the one
   * in use), from this point in its output. Never to the window that sized it.
   */
  | { type: "size"; tabId: string; cols: number; rows: number }
  /**
   * Entries in the tab's conversation. With `reset`, the whole of it (on
   * watching, or when the tab's session changes); otherwise more to append.
   * `session` is the Claude Code session's ID, or null when the tab has none.
   */
  | { type: "chat"; tabId: string; session: string | null; entries: ChatEntry[]; reset: boolean }
  /** `app` is what macOS calls the daemon in its dialogs ("Miks Helper"), if anything. */
  | { type: "permissions"; app: string | null; permissions: Permission[] }
  /**
   * The tab's open file as it is on disk: its text, or why there's none to
   * show. A file not there yet (`miks edit` of a new one) is empty, with no
   * `mtime`.
   */
  | { type: "file"; tabId: string; id: string; content: string | null; mtime: number | null; problem?: FileProblem }
  /** How a `saveFile` went: saved (its new `mtime`), or changed on disk since, or an error. */
  | { type: "fileSaved"; tabId: string; fileId?: string; mtime?: number; changed?: boolean; error?: string }
  /** A `readImage`'s image, base64, or why there's none. */
  | { type: "image"; requestId: string; data?: string; mime?: string; error?: string }
  /** A `findPaths`'s answer, in its order: each one's absolute path, or null if it isn't there. */
  | { type: "paths"; requestId: string; found: ({ path: string; folder: boolean } | null)[] };

// A pane whose program exits simply disappears from the next `state`.
