// The UI's view of the daemon, through the bridge the Electron preload
// exposes as `window.miks` (packages/app/preload.cjs). There's one
// connection per page; components read state with `useDaemon` and terminals
// subscribe to their pane's stream with `daemon.stream`.
import { ChatEntry, ClientMessage, DaemonMessage, DaemonState, Permission } from "miks/shared/protocol";
import type { Settings } from "miks/shared/settings";
import { useSyncExternalStore } from "react";

type Unsubscribe = () => void;

export type MiksBridge = {
  connect(): void;
  send(message: string): void;
  onMessage(listener: (message: string) => void): Unsubscribe;
  onStatus(listener: (status: { connected: boolean; error?: string; retrying?: boolean }) => void): Unsubscribe;
  onCommand(listener: (command: string) => void): Unsubscribe;
  pathForFile(file: File): string;
  sendFiles(tabId: string, paths: string[], into: "tmp" | "cwd"): Promise<string[]>;
  /** Whether there's an image on the clipboard, and in a window on another Mac, where it went there. */
  sendClipboardImage(tabId: string): Promise<{ image: boolean; path?: string }>;
  /** The session for this window's `miks browse` pages, through its daemon. */
  browsePartition(): Promise<string>;
  chooseBrowser(): Promise<string | null>;
  getSettings(): Settings;
  setSettings(changes: Partial<Settings>): void;
  onSettings(listener: (settings: Settings) => void): Unsubscribe;
  focus(): void;
  getTarget(): Target | null;
  onTarget(listener: (target: Target | null) => void): Unsubscribe;
  openRemote(id: string): void;
  confirm(options: { message: string; detail: string; button: string }): Promise<boolean>;
  copy(text: string): void;
};

/** Another Mac a window's daemon is on. */
export type Target = { name: string; color: string; host: string };

declare global {
  interface Window {
    miks?: MiksBridge;
  }
}

export type DaemonSnapshot = {
  state: DaemonState | null;
  connected: boolean;
  error: string | null;
  /** Whether it's trying again on its own (a remote window does). */
  retrying: boolean;
};

/** How the daemon's Mac lets its terminals' programs at things, as `permissions` hears it. */
export type PermissionsEvent = { app: string | null; permissions: Permission[] };

/** A tab's open file, as `watchFile` hears it. */
export type FileEvent = Omit<Extract<DaemonMessage, { type: "file" }>, "type" | "tabId">;
export type SaveResult = Omit<Extract<DaemonMessage, { type: "fileSaved" }>, "type" | "tabId">;

/** A tab's conversation, as `watchChat` hears it. */
export type ChatEvent = { session: string | null; entries: ChatEntry[]; reset: boolean };

export type PaneStreamEvent =
  | { type: "snapshot"; data: string; cols: number; rows: number }
  | { type: "output"; data: string };

class DaemonClient {
  private snapshot: DaemonSnapshot = { state: null, connected: false, error: null, retrying: false };
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, (event: PaneStreamEvent) => void>();
  private readonly chats = new Map<string, (event: ChatEvent) => void>();
  private readonly files = new Map<string, (event: FileEvent) => void>();
  private readonly saves = new Map<string, (result: SaveResult) => void>();
  private readonly connectListeners = new Set<() => void>();
  private readonly commandListeners = new Set<(command: string) => void>();
  private readonly permissionListeners = new Set<(event: PermissionsEvent) => void>();
  private readonly bridge: MiksBridge | undefined = window.miks;

  constructor() {
    if (!this.bridge) {
      this.update({ error: "Miks has to run inside its app (yarn dev), which connects it to the daemon." });
      return;
    }

    this.bridge.onStatus(({ connected, error, retrying = false }) => {
      if (!connected) {
        this.update({ connected, retrying, error: error ?? "The daemon stopped, taking its terminals with it." });
        return;
      }

      this.update({ connected, retrying: false, error: null });

      this.send({ type: "hello" });
      for (const tabId of this.chats.keys()) this.send({ type: "watchChat", tabId });
      for (const tabId of this.files.keys()) this.send({ type: "watchFile", tabId });
      for (const listener of this.connectListeners) listener();
    });

    this.bridge.onMessage((raw) => this.receive(JSON.parse(raw)));
    this.bridge.onCommand((command) => {
      for (const listener of this.commandListeners) listener(command);
    });

    this.bridge.connect();
  }

  /** Reconnects, starting the daemon again if it's gone. */
  reconnect() {
    this.update({ error: null });
    this.bridge?.connect();
  }

  send(message: ClientMessage) {
    if (this.snapshot.connected) this.bridge?.send(JSON.stringify(message));
  }

  /** Routes one pane's snapshot and output to its terminal. */
  stream(tabId: string, handler: (event: PaneStreamEvent) => void): Unsubscribe {
    this.streams.set(tabId, handler);
    return () => {
      if (this.streams.get(tabId) === handler) this.streams.delete(tabId);
    };
  }

  /**
   * Follows a tab's Claude Code conversation: all of it first (`reset`), then
   * what's added, again after every reconnection.
   */
  watchChat(tabId: string, handler: (event: ChatEvent) => void): Unsubscribe {
    this.chats.set(tabId, handler);
    this.send({ type: "watchChat", tabId });
    return () => {
      if (this.chats.get(tabId) !== handler) return;
      this.chats.delete(tabId);
      this.send({ type: "unwatchChat", tabId });
    };
  }

  /** Every `permissions` answer (ask with `send({ type: "permissions" })`). */
  onPermissions(listener: (event: PermissionsEvent) => void): Unsubscribe {
    this.permissionListeners.add(listener);
    return () => this.permissionListeners.delete(listener);
  }

  /** Follows a tab's open file: as it is now, then again whenever it changes on disk. */
  watchFile(tabId: string, handler: (event: FileEvent) => void): Unsubscribe {
    this.files.set(tabId, handler);
    this.send({ type: "watchFile", tabId });
    return () => {
      if (this.files.get(tabId) !== handler) return;
      this.files.delete(tabId);
      this.send({ type: "unwatchFile", tabId });
    };
  }

  /** Saves a tab's open file; see `saveFile` in the protocol. One at a time per tab. */
  saveFile(tabId: string, content: string, mtime: number | null, force = false): Promise<SaveResult> {
    if (!this.snapshot.connected) return Promise.resolve({ error: "Not connected to the daemon." });
    return new Promise((resolve) => {
      this.saves.set(tabId, resolve);
      this.send({ type: "saveFile", tabId, content, mtime, force });
    });
  }

  /** Called on every (re)connection, which is when terminals must attach. */
  onConnect(listener: () => void): Unsubscribe {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  /** Menu commands from the app (⌘T and friends). */
  onCommand(listener: (command: string) => void): Unsubscribe {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  get connected(): boolean {
    return this.snapshot.connected;
  }

  //
  // useSyncExternalStore plumbing.
  //

  subscribe = (listener: () => void): Unsubscribe => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): DaemonSnapshot => this.snapshot;

  private update(changes: Partial<DaemonSnapshot>) {
    this.snapshot = { ...this.snapshot, ...changes };
    for (const listener of this.listeners) listener();
  }

  private receive(message: DaemonMessage) {
    switch (message.type) {
      case "state":
        return this.update({ state: message.state });
      case "snapshot":
      case "output": {
        const { tabId, ...event } = message;
        return this.streams.get(tabId)?.(event);
      }
      case "chat": {
        const { tabId, ...event } = message;
        return this.chats.get(tabId)?.(event);
      }
      case "file": {
        const { tabId, ...event } = message;
        return this.files.get(tabId)?.(event);
      }
      case "fileSaved": {
        const { tabId, ...result } = message;
        this.saves.get(tabId)?.(result);
        this.saves.delete(tabId);
        return;
      }
      case "permissions": {
        const { type: _type, ...event } = message;
        for (const listener of this.permissionListeners) listener(event);
        return;
      }
    }
  }
}

export const daemon = new DaemonClient();

/** The Mac this window is on, if not this one: what the badge shows. */
export function useTarget(): Target | null {
  return useSyncExternalStore(subscribeTarget, getTarget);
}

let target: Target | null = window.miks?.getTarget?.() ?? null;
const targetListeners = new Set<() => void>();
window.miks?.onTarget?.((next) => {
  target = next;
  for (const listener of targetListeners) listener();
});
const getTarget = () => target;
const subscribeTarget = (listener: () => void) => {
  targetListeners.add(listener);
  return () => targetListeners.delete(listener);
};
export const isRemote = () => target !== null;

export function useDaemon(): DaemonSnapshot {
  return useSyncExternalStore(daemon.subscribe, daemon.getSnapshot);
}
