// The UI's view of the daemon, through the bridge the Electron preload
// exposes as `window.miks` (packages/app/preload.cjs). There's one
// connection per page; components read state with `useDaemon` and terminals
// subscribe to their pane's stream with `daemon.stream`.
import { AgentStatus, ChatEntry, ClientInfo, ClientMessage, DaemonMessage, DaemonState, Permission, RunningProgram, VersionInfo } from "miks/shared/protocol";
import type { Settings } from "miks/shared/settings";
import type { TailnetMac } from "miks/shared/tailscale";
import { useSyncExternalStore } from "react";
import { clientInfo } from "./client";

type Unsubscribe = () => void;

export type MiksBridge = {
  connect(): void;
  send(message: string): void;
  onMessage(listener: (message: string) => void): Unsubscribe;
  onStatus(listener: (status: BridgeStatus) => void): Unsubscribe;
  onCommand(listener: (command: string) => void): Unsubscribe;
  pathForFile(file: File): string;
  sendFiles(tabId: string, paths: string[], into: "tmp" | "cwd"): Promise<string[]>;
  /** Whether there's an image on the clipboard, and in a window on another Mac, where it went there. */
  sendClipboardImage(tabId: string): Promise<{ image: boolean; path?: string }>;
  /** The session for this window's `miks browse` pages, through its daemon. */
  browsePartition(): Promise<string>;
  /** Where there's no `<webview>` (the iOS app), the pages the app shows itself, over this one (ios/Miks/Pages.swift). */
  pages?: {
    tell(id: string, action: PageAction, args?: object): void;
    onState(listener: (state: PageState) => void): Unsubscribe;
  };
  chooseBrowser(): Promise<string | null>;
  getSettings(): Settings;
  setSettings(changes: Partial<Settings>): void;
  onSettings(listener: (settings: Settings) => void): Unsubscribe;
  focus(): void;
  /** Advertises this tab for Handoff (handoff.ts); missing from an older preload. */
  handoff?(path: string | null): void;
  /** A Handoff that arrived before any window was up. */
  takeHandoff?(): string | null;
  onHandoff?(listener: (path: string) => void): Unsubscribe;
  getTarget(): Target | null;
  onTarget(listener: (target: Target | null) => void): Unsubscribe;
  openRemote(id: string): void;
  /** The other Macs on this Mac's tailnet, for adding one, or why there are none; missing from an older preload. */
  tailnetMacs?(): Promise<{ macs?: TailnetMac[]; error?: string }>;
  /** What this window is and where, for `miks version`; missing from an older preload. */
  client?(): Omit<ClientInfo, "ui">;
  confirm(options: { message: string; detail: string; button: string }): Promise<boolean>;
  copy(text: string): void;
  /**
   * The Macs this device connects to (by their gateways' hosts and ports),
   * where the page isn't one a Mac served: the iOS app's. One is on screen.
   */
  macs?: {
    list(): Mac[];
    active(): string | null;
    /** Shows another (null: none, for adding one). */
    select(host: string | null): void;
    /** Adds one by what you typed ("air" works in the app) and shows it; why not, if it can't. */
    add(input: string): Promise<string | null>;
    remove(host: string): void;
    onChange(listener: () => void): Unsubscribe;
  };
};

export type PageAction = "open" | "frame" | "back" | "forward" | "reload" | "stop" | "focus" | "close";

/** Where one of the app's pages is, as it says whenever any of it changes, or a link of its that opens a new window. */
export type PageState =
  | { id: string; url: string; title: string; loading: boolean; back: boolean; forward: boolean; failed?: string }
  | { id: string; newTab: string };

export type BridgeStatus = {
  connected: boolean;
  error?: string;
  retrying?: boolean;
  /** What's on screen was another Mac's. */
  reset?: boolean;
};

/** One of the Macs a device connects to, and what its agents are doing, if it isn't the one shown. */
export type Mac = {
  host: string;
  name: string;
  active: boolean;
  connected: boolean;
  status: AgentStatus | null;
  /** Its workspaces, for the chooser; empty for the one shown. */
  workspaces: MacWorkspace[];
  /** When it was last connected (ms), if ever. */
  seen: number | null;
};

export type MacWorkspace = { title: string; status: AgentStatus | null };

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
export type SaveResult = Omit<Extract<DaemonMessage, { type: "fileSaved" }>, "type" | "tabId" | "fileId">;
/** An image for a markdown file, as `readImage` gets it. */
export type ImageResult = Omit<Extract<DaemonMessage, { type: "image" }>, "type" | "requestId">;
/** Paths in a terminal as found on the daemon's Mac, as `findPaths` gets them. */
export type FoundPath = Extract<DaemonMessage, { type: "paths" }>["found"][number];

/** A tab's conversation, as `watchChat` hears it. */
export type ChatEvent = { session: string | null; entries: ChatEntry[]; reset: boolean };

export type PaneStreamEvent =
  | { type: "snapshot"; data: string; cols: number; rows: number }
  | { type: "output"; data: string }
  | { type: "size"; cols: number; rows: number };

class DaemonClient {
  private snapshot: DaemonSnapshot = { state: null, connected: false, error: null, retrying: false };
  private readonly listeners = new Set<() => void>();
  private readonly streams = new Map<string, (event: PaneStreamEvent) => void>();
  private readonly chats = new Map<string, (event: ChatEvent) => void>();
  private readonly files = new Map<string, { tabId: string; fileId: string; handler: (event: FileEvent) => void; unsaved?: boolean }>();
  private readonly saves = new Map<string, { tabId: string; resolve: (result: SaveResult) => void }>();
  private readonly images = new Map<string, (result: ImageResult) => void>();
  private readonly foundPaths = new Map<string, (found: FoundPath[]) => void>();
  /** Each tab's chat panel draft, as the daemon has it (from any window). */
  private readonly drafts = new Map<string, string>();
  private readonly draftListeners = new Set<(tabId: string, text: string) => void>();
  private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** `transcribe`'s, `sendFile`'s and `running`'s, answered alike. */
  private readonly answers = new Map<string, (answer: any) => void>();
  private readonly connectListeners = new Set<() => void>();
  private readonly commandListeners = new Set<(command: string) => void>();
  private readonly permissionListeners = new Set<(event: PermissionsEvent) => void>();
  private readonly bridge: MiksBridge | undefined = window.miks;
  /** Not crypto.randomUUID(), which a page that isn't a secure context (plain http) doesn't have. */
  private requestCount = 0;

  constructor() {
    if (!this.bridge) {
      this.update({ error: "Miks has to run inside its app (yarn dev), which connects it to the daemon." });
      return;
    }

    this.bridge.onStatus(({ connected, error, retrying = false, reset }) => {
      if (!connected) {
        this.update({
          connected,
          retrying,
          error: error ?? "The daemon stopped, taking its terminals with it.",
          ...(reset && { state: null }),
        });
        return;
      }

      this.update({ connected, retrying: false, error: null });

      this.send({ type: "hello", client: clientInfo() });
      for (const tabId of this.chats.keys()) this.send({ type: "watchChat", tabId });
      for (const { tabId, fileId, unsaved } of this.files.values()) {
        this.send({ type: "watchFile", tabId, fileId });
        // Older daemons pass over messages they don't know.
        if (unsaved) this.send({ type: "fileUnsaved", tabId, fileId, unsaved });
      }
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

  /** Follows one of a tab's open files: as it is now, then again whenever it changes on disk. */
  watchFile(tabId: string, fileId: string, handler: (event: FileEvent) => void): Unsubscribe {
    const key = `${tabId}:${fileId}`;
    const watch = { tabId, fileId, handler };
    this.files.set(key, watch);
    this.send({ type: "watchFile", tabId, fileId });
    return () => {
      if (this.files.get(key) !== watch) return;
      this.files.delete(key);
      this.send({ type: "unwatchFile", tabId, fileId });
    };
  }

  /** Tells the daemon whether a file this window watches has changes it hasn't saved, so it's kept open. */
  /** Whether any of a tab's files has changes this window hasn't saved. */
  hasUnsaved(tabId: string): boolean {
    return [...this.files.values()].some((watch) => watch.tabId === tabId && watch.unsaved);
  }

  fileUnsaved(tabId: string, fileId: string, unsaved: boolean) {
    const watch = this.files.get(`${tabId}:${fileId}`);
    if (!watch || !!watch.unsaved === unsaved) return;
    watch.unsaved = unsaved;
    this.send({ type: "fileUnsaved", tabId, fileId, unsaved });
  }

  /** Saves one of a tab's open files; see `saveFile` in the protocol. One at a time per file. */
  saveFile(tabId: string, fileId: string, content: string, mtime: number | null, force = false): Promise<SaveResult> {
    if (!this.snapshot.connected) return Promise.resolve({ error: "Not connected to the daemon." });
    return new Promise((resolve) => {
      this.saves.set(fileId, { tabId, resolve });
      this.send({ type: "saveFile", tabId, fileId, content, mtime, force });
    });
  }

  /**
   * Which paths, as a tab's terminal shows them, are there on the daemon's
   * Mac; nothing from an older daemon, which never answers.
   */
  findPaths(tabId: string, paths: string[], { now = false } = {}): Promise<FoundPath[]> {
    if (!this.snapshot.connected || !this.speaks(10)) return Promise.resolve(paths.map(() => null));
    const requestId = String(++this.requestCount);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => answer(paths.map(() => null)), 5_000);
      const answer = (found: FoundPath[]) => {
        clearTimeout(timeout);
        this.foundPaths.delete(requestId);
        resolve(found);
      };
      this.foundPaths.set(requestId, answer);
      this.send({ type: "findPaths", requestId, tabId, paths, now });
    });
  }

  /**
   * Reads an image on the daemon's Mac, for a markdown file in a panel. An
   * older daemon never answers, so it gives up after a while.
   */
  readImage(path: string, mtime?: number): Promise<ImageResult> {
    return this.requestImage((requestId) => ({ type: "readImage", requestId, path, mtime }));
  }

  /** Fetches an image from the web, from the daemon's Mac, for a markdown file in a panel. */
  fetchImage(url: string): Promise<ImageResult> {
    return this.requestImage((requestId) => ({ type: "fetchImage", requestId, url }));
  }

  private requestImage(message: (requestId: string) => ClientMessage): Promise<ImageResult> {
    if (!this.snapshot.connected) return Promise.resolve({ error: "Not connected to the daemon." });
    const requestId = String(++this.requestCount);
    return new Promise((resolve) => {
      // Fetching waits on the web for up to 15s, so a little longer than that.
      const timeout = setTimeout(() => answer({ error: "The daemon didn't answer." }), 20_000);
      const answer = (result: ImageResult) => {
        clearTimeout(timeout);
        this.images.delete(requestId);
        resolve(result);
      };
      this.images.set(requestId, answer);
      this.send(message(requestId));
    });
  }

  /** A tab's draft as the daemon last had it, if it said: what another window has written there. */
  draft(tabId: string): string | undefined {
    return this.drafts.get(tabId);
  }

  /** This window's draft, for the others; sent once typing pauses a moment. */
  setDraft(tabId: string, text: string) {
    this.drafts.set(tabId, text);
    clearTimeout(this.draftTimers.get(tabId));
    this.draftTimers.set(
      tabId,
      setTimeout(() => {
        this.draftTimers.delete(tabId);
        if (this.speaks(11)) this.send({ type: "draft", tabId, text });
      }, 300),
    );
  }

  /** Hears another window's draft. */
  onDraft(listener: (tabId: string, text: string) => void): () => void {
    this.draftListeners.add(listener);
    return () => void this.draftListeners.delete(listener);
  }

  /** What's running in each tab, for what a restart would stop; null from an older daemon. */
  running(): Promise<RunningProgram[] | null> {
    if (!this.snapshot.connected || !this.speaks(11)) return Promise.resolve(null);
    const requestId = String(++this.requestCount);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => answer(null), 5_000);
      const answer = (running: RunningProgram[] | null) => {
        clearTimeout(timeout);
        this.answers.delete(requestId);
        resolve(running);
      };
      this.answers.set(requestId, answer);
      this.send({ type: "running", requestId });
    });
  }

  /** What `miks version` says, from this window; null from an older daemon. */
  version(): Promise<VersionInfo | null> {
    if (!this.snapshot.connected || !this.speaks(16)) return Promise.resolve(null);
    const requestId = String(++this.requestCount);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => answer(null), 5_000);
      const answer = (info: VersionInfo | null) => {
        clearTimeout(timeout);
        this.answers.delete(requestId);
        resolve(info);
      };
      this.answers.set(requestId, answer);
      this.send({ type: "version", requestId });
    });
  }

  /** Dictation's words: the audio, to text by Groq on the daemon's Mac (Dictation.ts). */
  async transcribe(audio: Blob): Promise<{ text?: string; error?: string }> {
    return this.ask({ type: "transcribe", requestId: "", audio: await base64(audio), mime: audio.type }, 40_000);
  }

  /** A file from a device without the Mac's files, into the daemon's tmpdir: where it went. */
  async sendFile(file: File): Promise<{ path?: string; error?: string }> {
    return this.ask({ type: "sendFile", requestId: "", name: file.name, data: await base64(file) }, 60_000);
  }

  private ask(message: Extract<ClientMessage, { type: "transcribe" | "sendFile" }>, wait: number) {
    if (!this.snapshot.connected) return Promise.resolve({ error: "Not connected to the daemon." });
    if (!this.speaks(11)) return Promise.resolve({ error: "This Mac's Miks is older: restart its daemon (Miks → Restart daemon…)." });
    const requestId = String(++this.requestCount);
    return new Promise<{ text?: string; path?: string; error?: string }>((resolve) => {
      const timeout = setTimeout(() => answer({ error: "The daemon didn't answer." }), wait);
      const answer = (result: { text?: string; path?: string; error?: string }) => {
        clearTimeout(timeout);
        this.answers.delete(requestId);
        resolve(result);
      };
      this.answers.set(requestId, answer);
      this.send({ ...message, requestId });
    });
  }

  /** Whether the daemon is at least this PROTOCOL_VERSION. */
  speaks(version: number): boolean {
    return (this.snapshot.state?.protocol ?? 0) >= version;
  }

  /** Called on every (re)connection, which is when terminals must attach. */
  onConnect(listener: () => void): Unsubscribe {
    this.connectListeners.add(listener);
    return () => this.connectListeners.delete(listener);
  }

  /** Runs a menu command, as the Mac app's menu does, from where there's no menu (the iOS app's switcher). */
  runCommand(command: string) {
    for (const listener of this.commandListeners) listener(command);
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
      case "output":
      case "size": {
        const { tabId, ...event } = message;
        return this.streams.get(tabId)?.(event);
      }
      case "chat": {
        const { tabId, ...event } = message;
        return this.chats.get(tabId)?.(event);
      }
      case "file": {
        const { tabId, ...event } = message;
        return this.files.get(`${tabId}:${event.id}`)?.handler(event);
      }
      case "fileSaved": {
        // An older daemon's has no fileId, but then the tab has the one file.
        const { tabId, fileId, ...result } = message;
        const id = fileId ?? [...this.saves].find(([, save]) => save.tabId === tabId)?.[0];
        if (!id) return;
        this.saves.get(id)?.resolve(result);
        this.saves.delete(id);
        return;
      }
      case "paths":
        return this.foundPaths.get(message.requestId)?.(message.found);
      case "image": {
        const { requestId, ...result } = message;
        return this.images.get(requestId)?.(result);
      }
      case "draft":
        this.drafts.set(message.tabId, message.text);
        for (const listener of this.draftListeners) listener(message.tabId, message.text);
        return;
      case "running":
        return this.answers.get(message.requestId)?.(message.running);
      case "version":
        return this.answers.get(message.requestId)?.(message.info);
      case "transcribed":
      case "fileSent": {
        const { type: _type, requestId, ...result } = message;
        return this.answers.get(requestId)?.(result);
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

/** The Macs this device connects to, in the iOS app; empty elsewhere. */
export function useMacs(): Mac[] {
  return useSyncExternalStore(subscribeMacs, getMacs);
}

let macs: Mac[] = window.miks?.macs?.list() ?? [];
window.miks?.macs?.onChange(() => (macs = window.miks!.macs!.list()));
const getMacs = () => macs;
const subscribeMacs = (listener: () => void) => window.miks?.macs?.onChange(listener) ?? (() => {});

export function useDaemon(): DaemonSnapshot {
  return useSyncExternalStore(daemon.subscribe, daemon.getSnapshot);
}

/** A blob's bytes as base64, for a message. */
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
