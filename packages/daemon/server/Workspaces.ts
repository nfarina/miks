import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import {
  type AgentKind,
  type AgentState,
  type Background,
  type ChatEntry,
  type DaemonState,
  type FileSpot,
  type GatewayState,
  type KeeperState,
  type OpenFile,
  type OpenPage,
  PROTOCOL_VERSION,
  type Tab,
} from "../shared/protocol.ts";
import { type FileContents, readForPanel, writeFromPanel } from "./Files.ts";
import { Pane } from "./Pane.ts";
import { BackgroundTasks } from "./BackgroundTasks.ts";
import { GrokTranscript, grokHook } from "./Grok.ts";
import { AGY_ASKING, AGY_BUSY, AGY_READY, AgyTranscript, agyHook, agyReply, agyTranscriptPath, findAgyConversation } from "./Antigravity.ts";
import { ClaudeTranscript } from "./ClaudeTranscript.ts";
import { findCodexSession } from "./CodexSessions.ts";
import { CodexTranscript } from "./CodexTranscript.ts";
import { Transcript, type TranscriptFormat } from "./Transcript.ts";
import type { MachineSettings } from "../shared/settings.ts";
import { loadMachineSettings, only, saveMachineSettings } from "./MachineSettings.ts";

/** What survives a daemon restart, in `state.json`. */
/** How long a finished turn waits for its session to end before it's `done`. */
const DONE_DELAY = 1000;

/** How long a turn Antigravity's just started gets to put its footer up. */
const AGY_SETTLE = 2000;

/** A Codex session too new to have an ID: the chat panel's open, with nothing to read yet. */
const NEW_SESSION = "new";

/** How long a permission request can be settled in without you. */
const WAITING_DELAY = 5000;
const MAX_RECENT_FILES = 500;

export type SavedState = {
  version: 1;
  activeWorkspace: number;
  /** Files opened in a panel, latest first. */
  recentFiles?: string[];
  workspaces: {
    title: string | null;
    cwd: string;
    activeTab: number;
    tabs: SavedTab[];
  }[];
};

/** A tab as it was: enough to bring it back, after a restart or closing it. */
export type SavedTab = {
  cwd: string;
  /** The agent session to resume. */
  session?: { agent: AgentKind; id: string; transcriptPath?: string };
  /** What older Miks saved instead of `session`. */
  claudeSessionId?: string;
  historyId?: string;
  keep?: string;
  page?: string;
  draft?: string;
  /** The files in its panel, oldest first. */
  files?: string[];
};

/**
 * A tab closed, with what its terminal showed (`Pane.snapshot`), unless
 * what comes back draws its own (a Claude session or a kept command).
 */
type ClosedTab = SavedTab & { screen?: { screen: string; cols: number; rows: number } };

/** What ⌘⇧T reopens, the latest first: kept in memory, a restart brings back what's open anyway. */
type Closed =
  | { kind: "tab"; workspaceId: string; index: number; tab: ClosedTab }
  | { kind: "workspace"; index: number; title: string | null; cwd: string; activeTab: number; tabs: ClosedTab[] }
  | { kind: "file"; tabId: string; path: string }
  | { kind: "page"; tabId: string; url: string };

const MAX_CLOSED = 20;

/** Hears a tab's open file: as it is now, and again whenever it changes on disk. */
export type FileListener = (file: FileContents & { id: string }) => void;

/** A file open in a tab's panel, who's watching it, and what's waiting for it to close. */
type OpenEntry = {
  file: OpenFile;
  listeners: Set<FileListener>;
  waiters: Set<() => void>;
  /** The watchers (windows) with changes to it they haven't saved. */
  unsaved: Set<FileListener>;
  /** When it last opened or came to the front, as a count: the least recent goes first to make room. */
  used: number;
  onDisk?: () => void;
};

/** A tab's panel holds this many files; past it, opening another closes the one least recently opened that's free to go. */
const MAX_FILES = 5;

/** Hears a tab's conversation: all of it with `reset`, then what's added. */
export type ChatListener = (chat: { session: string | null; entries: ChatEntry[]; reset: boolean }) => void;

type WorkspaceRecord = {
  id: string;
  title: string | null;
  cwd: string;
  tabIds: string[];
  activeTabId: string | null;
};

/**
 * Everything the daemon knows: workspaces, the panes in their tabs, and what
 * the agents in those panes are doing. Emits `change` after any mutation that
 * clients should hear about.
 */
export class Workspaces extends EventEmitter<{
  change: [];
  draft: [];
  /** A reopened tab's draft, for every window. */
  reopenedDraft: [tabId: string, text: string];
  machine: [];
}> {
  private readonly workspaces: WorkspaceRecord[] = [];
  private activeWorkspaceId: string | null = null;
  private readonly panes = new Map<string, Pane>();
  private readonly agents = new Map<string, AgentState>();
  /** The agent session in each tab, from its hooks, for resuming it. */
  private readonly sessions = new Map<
    string,
    { agent: AgentKind; id: string; transcriptPath?: string; seenRunning?: boolean }
  >();
  /** Tabs a restore started a session in (resumed, or a kept command's), until it ends. */
  private readonly restoredSessions = new Set<string>();
  /**
   * Commands run with `miks keep`, to run again if the tab is restored while
   * they still are. One stops being kept once its shell is back in front,
   * after having been seen running (it starts a moment after it registers).
   */
  private readonly keeps = new Map<string, { command: string; seenRunning: boolean }>();
  /** The gateway for your other devices on Tailscale, as the UI shows it. */
  private gateway: GatewayState | undefined;
  /** How "Stay awake, self-locked" is going (daemon/keeper), while it's chosen. */
  private keeper: KeeperState | undefined;
  private machine: MachineSettings;
  /** What each tab's Claude session has running in the background. */
  private readonly backgrounds = new Map<string, BackgroundTasks>();
  /** A finished turn waits a moment before it's `done` (see applyHook). */
  private readonly pendingDone = new Map<string, NodeJS.Timeout>();
  /** The title each tab's Codex was last looked up by, so it's once per title. */
  private readonly codexLookups = new Map<string, string>();
  /** A permission request waits a moment before it's `waiting` (see applyHook). */
  private readonly pendingWaiting = new Map<string, { timer?: NodeJS.Timeout; message?: string }>();
  /**
   * Tabs whose Codex has a title of its own spinning, which then says when
   * it's asking you, so a permission request alone never does.
   */
  private readonly codexTitled = new Set<string>();
  /**
   * The conversation in each tab someone's watching (the chat panel), read
   * from its agent session's transcript while there's one.
   */
  private readonly chats = new Map<
    string,
    { transcript: Transcript | null; ready: boolean; session: string | null; listeners: Set<ChatListener> }
  >();
  /**
   * The files in each tab's panel (`miks open`, `miks edit`), in the order
   * they opened, who's watching each, and what's waiting for it to close
   * (`miks edit --wait`).
   */
  private readonly files = new Map<string, OpenEntry[]>();
  private fileUses = 0;
  /** The page in each tab's panel (`miks browse`). */
  private readonly pages = new Map<string, OpenPage>();
  private readonly drafts = new Map<string, string>();
  /** Each tab's own shell history file's name, kept across restores. */
  private readonly historyIds = new Map<string, string>();
  /** What's been closed, for ⌘⇧T, the latest last. */
  private readonly closed: Closed[] = [];
  /** Every file opened lately, latest first, for ⌘P. */
  recentFiles: string[] = [];
  /** Each tab's shell's directory, as of the last `pollCwds`. */
  private readonly cwds = new Map<string, string>();
  private dark = true;
  /** Set by killAll: panes exiting now aren't to be replaced. */
  private stopping = false;

  private readonly socketPath: string;
  private readonly command?: string[];
  private readonly claudeCommand: string;
  private readonly codexCommand: string;
  private readonly agyCommand: string;
  private readonly grokCommand: string;

  constructor({
    socketPath,
    command,
    claudeCommand = "claude",
    codexCommand = "codex",
    agyCommand = "agy",
    grokCommand = "grok",
  }: {
    socketPath: string;
    command?: string[];
    /** What resumes a Claude session; tests substitute something harmless. */
    claudeCommand?: string;
    /** What resumes a Codex session; tests substitute something harmless. */
    codexCommand?: string;
    /** What resumes an Antigravity conversation; tests substitute something harmless. */
    agyCommand?: string;
    /** What resumes a grok session; tests substitute something harmless. */
    grokCommand?: string;
  }) {
    super();
    this.socketPath = socketPath;
    this.command = command;
    this.claudeCommand = claudeCommand;
    this.codexCommand = codexCommand;
    this.agyCommand = agyCommand;
    this.grokCommand = grokCommand;
    this.machine = loadMachineSettings(path.dirname(socketPath));
  }

  getState(): DaemonState {
    return {
      protocol: PROTOCOL_VERSION,
      home: os.homedir(),
      activeWorkspaceId: this.activeWorkspaceId,
      gateway: this.gateway,
      keeper: this.keeper,
      machine: this.machine,
      workspaces: this.workspaces.map((workspace) => ({
        id: workspace.id,
        title: workspace.title,
        cwd: workspace.cwd,
        activeTabId: workspace.activeTabId,
        tabs: workspace.tabIds.map((id) => this.getTab(id)),
      })),
    };
  }

  /**
   * Programs running in front of a shell, with where: what quitting would
   * stop. `kept`: a restore brings it back (`miks keep`, or a Claude session
   * to resume); `active`: it's mid-task (a Claude turn working or waiting on
   * you), which even a restore would cut short.
   */
  running(): { program: string; cwd: string | null; kept: boolean; active: boolean; background?: Background }[] {
    return this.workspaces.flatMap((workspace) =>
      workspace.tabIds.flatMap((id) => {
        const program = this.panes.get(id)?.running();
        if (!program) return [];
        const status = this.agents.get(id)?.status;
        return [
          {
            program,
            cwd: this.cwds.get(id) ?? null,
            kept: this.keeps.has(id) || !!this.resumableSession(id),
            active: status === "working" || status === "waiting",
            // A resumed session doesn't start these again.
            background: this.backgrounds.get(id)?.counts(),
          },
        ];
      }),
    );
  }

  getPane(tabId: string): Pane | undefined {
    return this.panes.get(tabId);
  }

  createWorkspace({ cwd = os.homedir(), title }: { cwd?: string; title?: string } = {}): string {
    const workspace: WorkspaceRecord = {
      id: shortId(),
      title: title ?? null,
      cwd,
      tabIds: [],
      activeTabId: null,
    };
    this.workspaces.push(workspace);
    this.activeWorkspaceId = workspace.id;
    this.createTab(workspace.id);
    return workspace.id;
  }

  closeWorkspace(workspaceId: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    this.remember({
      kind: "workspace",
      index: this.workspaces.indexOf(workspace),
      title: workspace.title,
      cwd: workspace.cwd,
      activeTab: Math.max(0, workspace.tabIds.indexOf(workspace.activeTabId ?? "")),
      tabs: workspace.tabIds.map((tabId) => this.closingTab(tabId, workspace.cwd)),
    });
    // Each pane's exit removes its tab, and the last one removes the workspace.
    for (const tabId of workspace.tabIds) this.panes.get(tabId)?.kill();
  }

  renameWorkspace(workspaceId: string, title: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    workspace.title = title.trim() || null;
    this.emit("change");
  }

  /**
   * A new tab where you are: just right of the current tab, in its
   * directory, asked of its shell just now (the poll's could be seconds
   * old), or the workspace's.
   */
  async newTab(workspaceId: string): Promise<string | undefined> {
    const activeTabId = this.findWorkspace(workspaceId)?.activeTabId;
    const pane = activeTabId ? this.panes.get(activeTabId) : undefined;
    const cwd = (await pane?.cwd()) ?? (activeTabId ? this.cwds.get(activeTabId) : undefined);
    return this.createTab(workspaceId, { cwd, after: activeTabId ?? undefined });
  }

  createTab(
    workspaceId: string,
    {
      cwd,
      resume,
      keep,
      historyId = randomUUID(),
      after,
      screen,
    }: {
      cwd?: string;
      resume?: SavedTab["session"];
      keep?: string;
      historyId?: string;
      after?: string;
      screen?: ClosedTab["screen"];
    } = {},
  ): string | undefined {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    const id = shortId();
    const pane = new Pane({
      id,
      cwd: cwd ?? workspace.cwd,
      // A kept command first: an agent session in such a tab is one it ran.
      command: keep ? this.thenShell(keep) : resume ? this.thenShell(this.resumeCommand(resume)) : this.command,
      dark: this.dark,
      ...screen,
      env: { MIKS_PANE_ID: id, MIKS_SOCKET: this.socketPath, MIKS_HISTORY: this.historyFile(historyId) },
    });
    this.panes.set(id, pane);
    this.historyIds.set(id, historyId);
    if (keep) this.keeps.set(id, { command: keep, seenRunning: false });
    if (keep || resume) this.restoredSessions.add(id);
    // Codex and Antigravity say nothing until the first prompt, by when
    // another restart would have lost it, and the chat panel would have been
    // empty till then.
    if (resume && resume.agent !== "claude") {
      this.sessions.set(id, { ...resume, seenRunning: false });
      this.agents.set(id, { kind: resume.agent, status: "idle", since: Date.now() });
    }
    // After the tab named, or at the end.
    const index = after ? workspace.tabIds.indexOf(after) : -1;
    workspace.tabIds.splice(index === -1 ? workspace.tabIds.length : index + 1, 0, id);
    workspace.activeTabId = id;

    pane.on("title", (title, previous) => {
      this.applyTitle(id, title, previous);
      this.emit("change");
    });
    pane.on("exit", () => this.removeTab(id));

    this.emit("change");
    return id;
  }

  closeTab(tabId: string) {
    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    const pane = this.panes.get(tabId);
    if (!workspace || !pane) return;
    // Its last: the workspace goes with it, and comes back with it.
    if (workspace.tabIds.length === 1) return this.closeWorkspace(workspace.id);

    this.remember({ kind: "tab", workspaceId: workspace.id, index: workspace.tabIds.indexOf(tabId), tab: this.closingTab(tabId, workspace.cwd) });
    pane.kill();
  }

  /** A file closed from the panel (✕, ⌘W, Done), to reopen. */
  closeFileByHand(tabId: string, fileId?: string) {
    const open = this.openEntry(tabId, fileId);
    if (open) this.remember({ kind: "file", tabId, path: open.file.path });
    this.closeFile(tabId, fileId);
  }

  /**
   * Brings back what was closed last (⌘⇧T), where it was: a tab or
   * workspace with its directory, history, Claude session, kept command,
   * panel and, for a plain shell, what its terminal showed; a file or page
   * into its tab, while that's still open.
   */
  reopen() {
    for (let closed = this.closed.pop(); closed; closed = this.closed.pop()) {
      switch (closed.kind) {
        case "tab": {
          // Its workspace closed since: into the one on screen.
          const workspace = this.findWorkspace(closed.workspaceId) ?? this.findWorkspace(this.activeWorkspaceId ?? "");
          if (!workspace) break;
          const tabId = this.reopenTab(workspace, closed.tab);
          if (!tabId) break;
          // Where it was, as near as the tabs still there allow.
          workspace.tabIds.splice(workspace.tabIds.indexOf(tabId), 1);
          workspace.tabIds.splice(Math.min(closed.index, workspace.tabIds.length), 0, tabId);
          this.activeWorkspaceId = workspace.id;
          this.emit("change");
          return;
        }
        case "workspace": {
          const workspace: WorkspaceRecord = { id: shortId(), title: closed.title, cwd: closed.cwd, tabIds: [], activeTabId: null };
          this.workspaces.splice(Math.min(closed.index, this.workspaces.length), 0, workspace);
          for (const tab of closed.tabs) this.reopenTab(workspace, tab);
          workspace.activeTabId = workspace.tabIds[closed.activeTab] ?? workspace.tabIds[0] ?? null;
          this.activeWorkspaceId = workspace.id;
          this.emit("change");
          return;
        }
        case "file":
          if (!this.panes.has(closed.tabId)) break;
          this.selectTab(closed.tabId);
          void this.openFile(closed.tabId, closed.path, { edit: false, wait: false });
          return;
        case "page":
          if (!this.panes.has(closed.tabId)) break;
          this.selectTab(closed.tabId);
          this.openPage(closed.tabId, closed.url);
          return;
      }
    }
  }

  private reopenTab(workspace: WorkspaceRecord, tab: ClosedTab): string | undefined {
    const tabId = this.createTab(workspace.id, {
      cwd: tab.cwd,
      resume: tab.session,
      keep: tab.keep,
      historyId: tab.historyId,
      screen: tab.screen,
    });
    if (!tabId) return;
    if (tab.page) this.openPage(tabId, tab.page);
    if (tab.draft) {
      this.drafts.set(tabId, tab.draft);
      this.emit("reopenedDraft", tabId, tab.draft);
    }
    for (const file of tab.files ?? []) void this.openFile(tabId, file, { edit: false, wait: false });
    return tabId;
  }

  private selectTab(tabId: string) {
    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    if (workspace) this.select(workspace.id, tabId);
  }

  /** A tab about to close, as it is: in the directory it was last polled in (lsof would hold the close up). */
  private closingTab(tabId: string, workspaceCwd: string): ClosedTab {
    const tab = this.savedTab(tabId, this.cwds.get(tabId) ?? workspaceCwd);
    const drawsItself = tab.session || tab.keep;
    return drawsItself ? tab : { ...tab, screen: this.panes.get(tabId)?.snapshot() };
  }

  private savedTab(tabId: string, cwd: string): SavedTab {
    const files = this.files.get(tabId)?.map((open) => open.file.path);
    return {
      cwd,
      session: this.resumableSession(tabId),
      historyId: this.historyIds.get(tabId),
      keep: this.keeps.get(tabId)?.command,
      page: this.pages.get(tabId)?.url,
      draft: this.drafts.get(tabId),
      ...(files?.length ? { files } : {}),
    };
  }

  private remember(closed: Closed) {
    this.closed.push(closed);
    for (const dropped of this.closed.splice(0, this.closed.length - MAX_CLOSED)) {
      // Its tabs' histories, kept for it, go now.
      const tabs = dropped.kind === "tab" ? [dropped.tab] : dropped.kind === "workspace" ? dropped.tabs : [];
      for (const tab of tabs) if (tab.historyId && !this.historyInUse(tab.historyId)) fs.rmSync(this.historyFile(tab.historyId), { force: true });
    }
  }

  /** Whether a tab open, or one that could reopen, has this history. */
  private historyInUse(historyId: string): boolean {
    if ([...this.historyIds.values()].includes(historyId)) return true;
    return this.closed.some(
      (closed) =>
        (closed.kind === "tab" && closed.tab.historyId === historyId) ||
        (closed.kind === "workspace" && closed.tabs.some((tab) => tab.historyId === historyId)),
    );
  }

  moveWorkspace(workspaceId: string, index: number) {
    const from = this.workspaces.findIndex((w) => w.id === workspaceId);
    if (from === -1) return;

    const [workspace] = this.workspaces.splice(from, 1);
    this.workspaces.splice(clamp(index, 0, this.workspaces.length), 0, workspace);
    this.emit("change");
  }

  moveTab(tabId: string, index: number) {
    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    if (!workspace) return;

    workspace.tabIds.splice(workspace.tabIds.indexOf(tabId), 1);
    workspace.tabIds.splice(clamp(index, 0, workspace.tabIds.length), 0, tabId);
    this.emit("change");
  }

  setDark(dark: boolean) {
    this.dark = dark;
    for (const pane of this.panes.values()) pane.setDark(dark);
  }

  /** Notices programs starting and exiting in front, for tab titles. */
  pollForeground() {
    let changed = false;
    for (const pane of this.panes.values()) changed = pane.pollForeground() || changed;

    for (const [tabId, kept] of this.keeps) {
      if (this.panes.get(tabId)?.running()) kept.seenRunning = true;
      else if (kept.seenRunning) {
        this.keeps.delete(tabId);
        changed = true;
      }
    }

    // Quitting Codex can leave its thread with a daemon of its own, which
    // never ends the session, and Antigravity has no such hook, so they're
    // over here when the shell's back.
    for (const [tabId, session] of this.sessions) {
      if (session.agent === "claude") continue;
      if (this.panes.get(tabId)?.running()) session.seenRunning = true;
      if (this.panes.get(tabId)?.running() || !session.seenRunning) continue;
      this.endSession(tabId);
      changed = true;
    }

    for (const [tabId, pane] of this.panes) {
      if (pane.running() === "agy") changed = this.pollAgy(tabId, pane) || changed;
      const known = this.sessions.get(tabId);
      if (pane.running() !== "codex" || (known && known.id !== NEW_SESSION)) continue;
      const title = pane.displayTitle;
      if (this.codexLookups.get(tabId) === title) continue;
      this.codexLookups.set(tabId, title);

      // Until it's past any trust screen or resume picker, Codex has set no
      // title of its own. Then it's a thread you resumed, or a new one, which
      // has no ID to know until the first prompt's hooks bring it.
      const session = findCodexSession(title) ?? (title && title !== "codex" ? { id: NEW_SESSION } : undefined);
      if (!session || (known && session.id === NEW_SESSION)) continue;
      this.sessions.set(tabId, { agent: "codex", ...session, seenRunning: true });
      this.agents.set(tabId, { kind: "codex", status: "idle", since: Date.now() });
      this.updateChat(tabId);
      changed = true;
    }

    if (changed) this.emit("change");
  }

  /** `miks keep <command>` in a tab: run it again if the tab is restored. */
  keep(tabId: string, command: string) {
    if (!this.panes.has(tabId) || !command.trim()) return;
    this.keeps.set(tabId, { command, seenRunning: false });
    this.emit("change");
  }

  /**
   * Refreshes every tab's directory with one `lsof` for all the shells, since
   * nothing tells us when a shell cd's. Emits `change` only if one moved.
   */
  async pollCwds() {
    const panes = [...this.panes.values()];
    if (panes.length === 0) return;

    const byPid = await shellCwds(panes.map((pane) => pane.pid));
    let changed = false;
    for (const pane of panes) {
      const cwd = byPid.get(pane.pid);
      if (!cwd || this.cwds.get(pane.id) === cwd) continue;
      this.cwds.set(pane.id, cwd);
      changed = true;
    }
    if (changed) this.emit("change");
  }

  select(workspaceId: string, tabId?: string) {
    const workspace = this.findWorkspace(workspaceId);
    if (!workspace) return;

    this.activeWorkspaceId = workspace.id;
    if (tabId && workspace.tabIds.includes(tabId)) workspace.activeTabId = tabId;
    if (workspace.activeTabId) this.markSeen(workspace.activeTabId);

    this.emit("change");
  }

  markSeen(tabId: string) {
    const agent = this.agents.get(tabId);
    if (agent?.status !== "done") return;

    this.agents.set(tabId, { ...agent, status: "idle", since: Date.now() });
    this.emit("change");
  }

  /**
   * Applies an agent's hook event, posted by its hook script with the hook's
   * own JSON payload (see `hooks/`). Codex's are Claude Code's, nearly to the
   * field, with `PermissionRequest` for `Notification`.
   */
  applyHook(tabId: string, payload: any, kind: AgentKind = "claude") {
    if (!this.panes.has(tabId)) return;
    if (kind === "antigravity") payload = agyHook(payload);
    if (kind === "grok") payload = grokHook(payload);
    if (!payload) return;
    // A Codex subagent's session isn't the tab's.
    if (kind === "codex" && payload?.agent_id) return;

    const event: string | undefined = payload?.hook_event_name;
    // Session IDs are UUIDs; anything else isn't one we'd put in a command.
    const sessionId = payload?.session_id;
    if (typeof sessionId === "string" && /^[\w-]+$/.test(sessionId)) {
      const transcriptPath = typeof payload?.transcript_path === "string" ? payload.transcript_path : undefined;
      this.sessions.set(tabId, { agent: kind, id: sessionId, transcriptPath, seenRunning: true });
      this.updateChat(tabId);
      if (transcriptPath && kind === "claude") this.followBackground(tabId, transcriptPath);
    }

    const set = (status: AgentState["status"], message?: string) =>
      this.agents.set(tabId, { kind, status, message, since: Date.now() });

    // Whatever comes next supersedes a turn waiting to be `done`.
    clearTimeout(this.pendingDone.get(tabId));
    this.pendingDone.delete(tabId);
    this.cancelWaiting(tabId);

    switch (event) {
      case "SessionStart":
        set("idle");
        break;
      case "UserPromptSubmit":
      case "PostToolUse":
        // PostToolUse is what moves us off `waiting` once a permission
        // prompt is approved and the tool has run.
        set("working");
        break;
      case "Notification":
        // The idle reminder ("Claude is waiting for your input") arrives a
        // minute after a turn ends. `done` already covers a finished turn,
        // but it also catches one that ended without saying so.
        if (payload?.notification_type === "idle_prompt") {
          if (this.agents.get(tabId)?.status !== "working") return;
          set("idle");
          break;
        }
        set("waiting", payload?.message);
        break;
      case "PermissionRequest": {
        // Fires for what Codex's own auto-reviewer settles too, with nobody
        // asked. Its title says when you are (applyTitle), and failing that
        // (it can be configured away), one still open after a moment is yours.
        const message = typeof payload?.tool_input?.description === "string" ? payload.tool_input.description : undefined;
        // An auto-reviewer can take longer than the timer (a guardian
        // subagent's review took 3.6s live), and its title never says it's
        // asking you meanwhile, so with a title to go by, only that counts.
        if (this.codexTitled.has(tabId)) {
          this.pendingWaiting.set(tabId, { message });
          return;
        }
        const timer = setTimeout(() => {
          this.pendingWaiting.delete(tabId);
          if (!this.agents.has(tabId)) return;
          this.agents.set(tabId, { kind, status: "waiting", message, since: Date.now() });
          this.emit("change");
        }, WAITING_DELAY);
        timer.unref();
        this.pendingWaiting.set(tabId, { timer, message });
        return;
      }
      case "Interrupted":
        set("idle");
        break;
      case "Stop": {
        // A one-shot `claude -p` (a script's, say) ends its session right
        // after its turn, 25ms later in practice; nothing for you to see, so
        // no `done` (and no notification). An interactive session stays.
        const timer = setTimeout(() => {
          this.pendingDone.delete(tabId);
          if (!this.agents.has(tabId)) return;
          // Antigravity's is only in its transcript, a moment behind the hook.
          const reply = kind === "antigravity" ? agyReply(payload?.transcript_path) : payload?.last_assistant_message;
          const replyLines = typeof reply === "string" ? reply.split("\n").length : undefined;
          // More than a notification shows; the whole reply is in the panel.
          const replyStart = typeof reply === "string" ? reply.slice(0, 500) : undefined;
          this.agents.set(tabId, { kind, status: "done", since: Date.now(), replyLines, reply: replyStart });
          this.emit("change");
        }, DONE_DELAY);
        timer.unref();
        this.pendingDone.set(tabId, timer);
        return;
      }
      case "SessionEnd":
        this.endSession(tabId);
        break;
      default:
        return;
    }

    this.emit("change");
  }

  /**
   * Claude Code and Codex both animate their titles while a turn runs (◐ ◑,
   * or braille), and Claude Code shows ✳ when it stops. Interrupting with Esc
   * fires no hook at all, so the spinner stopping is how we hear about it: the
   * turn is over, and since you ended it yourself there's nothing new to see.
   * Only the change from spinning to stopped counts, never a ✳ on its own,
   * which can trail a prompt just submitted. Codex's title also says when it
   * has asked you something, which is what `waiting` needs and no hook tells:
   * a permission request or a question, blinking `[ . ]` and `[ ! ]`.
   */
  getMachineSettings(): MachineSettings {
    return this.machine;
  }

  /** From any window on this daemon: this Mac's, kept for all of them. */
  setMachineSettings(changes: Partial<MachineSettings>) {
    this.machine = { ...this.machine, ...only(changes) };
    try {
      saveMachineSettings(path.dirname(this.socketPath), this.machine);
    } catch {}
    this.emit("machine");
    this.emit("change");
  }

  setKeeper(keeper: KeeperState | undefined) {
    this.keeper = keeper;
    this.emit("change");
  }

  setGateway(gateway: GatewayState | undefined) {
    this.gateway = gateway;
    this.emit("change");
  }

  /**
   * What Antigravity's hooks don't say, from its screen: that it's up and
   * taking prompts, before any hook; that it's asking you something; and Esc
   * ending a turn, which fires none (its footer's "esc to cancel" goes).
   */
  private pollAgy(tabId: string, pane: Pane): boolean {
    const screen = pane.screenText();

    if (!this.sessions.has(tabId)) {
      if (!AGY_READY.test(screen)) return false;
      this.sessions.set(tabId, { agent: "antigravity", id: NEW_SESSION, seenRunning: true });
      this.agents.set(tabId, { kind: "antigravity", status: "idle", since: Date.now() });
      this.updateChat(tabId);
      void findAgyConversation(pane.pid).then((id) => {
        if (!id || this.sessions.get(tabId)?.id !== NEW_SESSION) return;
        this.sessions.set(tabId, { agent: "antigravity", id, transcriptPath: agyTranscriptPath(id), seenRunning: true });
        this.updateChat(tabId);
        this.emit("change");
      });
      return true;
    }

    const agent = this.agents.get(tabId);
    if (agent?.kind !== "antigravity") return false;

    const asking = AGY_ASKING.test(screen);
    const status =
      asking ? "waiting"
      : agent.status === "waiting" ? AGY_BUSY.test(screen) ? "working" : "idle"
      : agent.status === "working" && !AGY_BUSY.test(screen) && Date.now() - agent.since > AGY_SETTLE ? "idle"
      : agent.status;
    if (status === agent.status) return false;
    this.agents.set(tabId, { ...agent, status, message: undefined, since: Date.now() });
    return true;
  }

  private endSession(tabId: string) {
    // The agent takes its background work with it.
    this.backgrounds.get(tabId)?.close();
    this.backgrounds.delete(tabId);
    this.agents.delete(tabId);
    this.sessions.delete(tabId);
    this.codexLookups.delete(tabId);
    this.codexTitled.delete(tabId);
    this.restoredSessions.delete(tabId);
    this.updateChat(tabId);
  }

  private cancelWaiting(tabId: string) {
    clearTimeout(this.pendingWaiting.get(tabId)?.timer);
    this.pendingWaiting.delete(tabId);
  }

  private followBackground(tabId: string, transcriptPath: string) {
    let background = this.backgrounds.get(tabId);
    if (!background) {
      background = new BackgroundTasks();
      background.on("change", () => this.emit("change"));
      this.backgrounds.set(tabId, background);
    }
    background.follow(transcriptPath);
  }

  private applyTitle(tabId: string, title: string, previous: string) {
    const agent = this.agents.get(tabId);
    if (agent?.kind === "codex" && WORKING_TITLE.test(title)) this.codexTitled.add(tabId);
    if (agent?.kind === "codex" && CODEX_ASKING_TITLE.test(title)) {
      if (agent.status === "waiting") return;
      const message = this.pendingWaiting.get(tabId)?.message;
      this.cancelWaiting(tabId);
      this.agents.set(tabId, { ...agent, status: "waiting", message, since: Date.now() });
      return;
    }
    if (agent?.kind === "codex" && agent.status === "waiting" && CODEX_ASKING_TITLE.test(previous)) {
      // Answered: it carries on, or (Esc) that's the end of the turn.
      const status = WORKING_TITLE.test(title) ? "working" : "idle";
      this.agents.set(tabId, { ...agent, status, message: undefined, since: Date.now() });
      return;
    }
    if (agent?.status !== "working" || !WORKING_TITLE.test(previous)) return;
    if (agent.kind === "claude" ? !CLAUDE_IDLE_TITLE.test(title) : WORKING_TITLE.test(title)) return;

    this.cancelWaiting(tabId);
    this.agents.set(tabId, { ...agent, status: "idle", message: undefined, since: Date.now() });
  }

  /**
   * The layout as it stands, with each tab's current directory (where its
   * shell has cd'ed to, not where it started) and its agent session, if any.
   */
  async save(): Promise<SavedState> {
    const workspaces = await Promise.all(
      this.workspaces.map(async (workspace) => ({
        title: workspace.title,
        cwd: workspace.cwd,
        activeTab: Math.max(0, workspace.tabIds.indexOf(workspace.activeTabId ?? "")),
        tabs: await Promise.all(
          workspace.tabIds.map(async (tabId) => this.savedTab(tabId, (await this.panes.get(tabId)?.cwd()) ?? workspace.cwd)),
        ),
      })),
    );

    return {
      version: 1,
      activeWorkspace: Math.max(0, this.workspaces.findIndex((w) => w.id === this.activeWorkspaceId)),
      recentFiles: this.recentFiles,
      workspaces,
    };
  }

  /**
   * Rebuilds a saved layout with fresh shells, each in its tab's directory.
   * A tab that had an agent session resumes it, so a daemon restart costs a
   * moment, not your agents.
   */
  restore(saved: SavedState) {
    this.recentFiles = saved.recentFiles ?? [];
    for (const savedWorkspace of saved.workspaces) {
      if (savedWorkspace.tabs.length === 0) continue;

      const workspace: WorkspaceRecord = {
        id: shortId(),
        title: savedWorkspace.title,
        cwd: savedWorkspace.cwd,
        tabIds: [],
        activeTabId: null,
      };
      this.workspaces.push(workspace);

      for (const tab of savedWorkspace.tabs) {
        const tabId = this.createTab(workspace.id, {
          cwd: tab.cwd,
          resume: tab.session ?? (tab.claudeSessionId ? { agent: "claude", id: tab.claudeSessionId } : undefined),
          keep: tab.keep,
          historyId: tab.historyId,
        });
        if (tabId && tab.page) this.openPage(tabId, tab.page);
        if (tabId && tab.draft) this.drafts.set(tabId, tab.draft);
        for (const file of tab.files ?? []) if (tabId) void this.openFile(tabId, file, { edit: false, wait: false });
      }
      workspace.activeTabId = workspace.tabIds[savedWorkspace.activeTab] ?? workspace.tabIds[0] ?? null;
    }

    this.activeWorkspaceId = this.workspaces[saved.activeWorkspace]?.id ?? this.workspaces[0]?.id ?? null;
    this.emit("change");

    // Histories of tabs that didn't come back (a crash lost their state).
    const kept = new Set([...this.historyIds.values()].map((id) => `${id}.zsh`));
    try {
      for (const file of fs.readdirSync(this.historyDir())) {
        if (!kept.has(file)) fs.rmSync(path.join(this.historyDir(), file), { force: true });
      }
    } catch {}
  }

  /**
   * Where a tab's own shell history goes (Miks's zsh startup files keep it):
   * the commands it ran, read back when the tab is restored, so ↑ picks up
   * where you were in that tab.
   */
  private historyDir(): string {
    return path.join(path.dirname(this.socketPath), "history");
  }

  private historyFile(historyId: string): string {
    fs.mkdirSync(this.historyDir(), { recursive: true, mode: 0o700 });
    return path.join(this.historyDir(), `${historyId}.zsh`);
  }

  /**
   * The tab's agent session, if there's anything to resume. Claude Code only
   * writes a transcript once the session has a message (and never for a child
   * session); resuming one without fails with "No conversation found".
   */
  private resumableSession(tabId: string): SavedTab["session"] {
    const session = this.sessions.get(tabId);
    if (!session || session.id === NEW_SESSION) return;
    if (session.transcriptPath && !fs.existsSync(session.transcriptPath)) return;
    return { agent: session.agent, id: session.id, transcriptPath: session.transcriptPath };
  }

  private resumeCommand({ agent, id }: NonNullable<SavedTab["session"]>): string {
    if (agent === "codex") return `${this.codexCommand} resume ${id}`;
    if (agent === "antigravity") return `${this.agyCommand} --conversation ${id}`;
    if (agent === "grok") return `${this.grokCommand} --resume ${id}`;
    return `${this.claudeCommand} --resume ${id}`;
  }

  /**
   * Resumes an agent session, then leaves you in an ordinary shell when it
   * exits. Interactive as well as login, so the shell reads .zshrc, which is
   * often where `claude` gets onto the PATH.
   */
  private thenShell(command: string): string[] {
    const shell = this.command?.[0] ?? (process.env.SHELL || "/bin/zsh");
    return [shell, "-ilc", `${command}; exec ${shell} -l`];
  }

  /**
   * Follows a tab's agent conversation, through every session it has
   * (`/clear` starts another), until the returned function is called.
   */
  watchChat(tabId: string, listener: ChatListener): () => void {
    if (!this.panes.has(tabId)) return () => {};

    let chat = this.chats.get(tabId);
    if (!chat) {
      chat = { transcript: null, ready: false, session: null, listeners: new Set() };
      this.chats.set(tabId, chat);
      this.updateChat(tabId);
    }
    chat.listeners.add(listener);
    // Otherwise it hears it all once the transcript's been read.
    if (chat.ready) listener({ session: this.chatSession(tabId), entries: chat.transcript?.entries ?? [], reset: true });

    return () => {
      const current = this.chats.get(tabId);
      if (!current?.listeners.delete(listener) || current.listeners.size > 0) return;
      current.transcript?.close();
      this.chats.delete(tabId);
    };
  }

  /** Points a watched tab's conversation at its current session's transcript. */
  private updateChat(tabId: string) {
    const chat = this.chats.get(tabId);
    if (!chat) return;

    const session = this.sessions.get(tabId);
    const file = session?.transcriptPath ?? null;
    // Already following it (or, with no session, already said so).
    const unchanged = (chat.transcript?.file ?? null) === file && (chat.transcript || chat.ready);
    if (unchanged && chat.session === this.chatSession(tabId)) return;

    chat.transcript?.close();
    const transcript = file ? new Transcript(file, this.transcriptFormat(session?.agent)) : null;
    chat.transcript = transcript;
    chat.ready = false;

    const chatSession = this.chatSession(tabId);
    chat.session = chatSession;
    const tell = (entries: ChatEntry[], reset: boolean) => {
      for (const listener of chat.listeners) listener({ session: chatSession, entries, reset });
    };
    // All of it at once when it's been read (a long one takes a moment),
    // rather than an empty conversation that then fills in.
    const start = () => {
      if (chat.transcript !== transcript) return;
      chat.ready = true;
      tell(transcript?.entries ?? [], true);
      transcript?.on("entries", (entries) => tell(entries, false));
      transcript?.on("reset", (entries) => tell(entries, true));
    };
    if (transcript) void transcript.ready.then(start);
    else start();
  }

  private transcriptFormat(agent: AgentKind | undefined): TranscriptFormat {
    if (agent === "codex") return new CodexTranscript();
    if (agent === "antigravity") return new AgyTranscript();
    if (agent === "grok") return new GrokTranscript();
    return new ClaudeTranscript();
  }

  private chatSession(tabId: string): string | null {
    const session = this.sessions.get(tabId);
    if (session?.id === NEW_SESSION) return NEW_SESSION;
    return this.chats.get(tabId)?.transcript ? (session?.id ?? null) : null;
  }

  /**
   * Shows a file in the tab's panel, beside any it had (the least recently
   * opened of those with nothing unsaved or waiting on them going, past
   * MAX_FILES). Open already, it comes to the front as it is, unsaved
   * changes and all, and to edit or wait on, it's now for that, whatever
   * waited on it before going on. With `wait`, resolves once it's closed
   * (the panel's Done or close, it opening again, or the tab closing);
   * otherwise at once.
   */
  openFile(
    tabId: string,
    file: string,
    { edit, wait, preview = false, at }: { edit: boolean; wait: boolean; preview?: boolean; at?: FileSpot },
  ): Promise<void> {
    if (!this.panes.has(tabId)) return Promise.resolve();

    this.recentFiles = [file, ...this.recentFiles.filter((path) => path !== file)].slice(0, MAX_RECENT_FILES);
    const list = this.files.get(tabId) ?? [];
    this.files.set(tabId, list);
    const already = list.find((open) => open.file.path === file);
    if (already) {
      already.used = ++this.fileUses;
      if (edit || wait) {
        for (const resolve of already.waiters) resolve();
        already.waiters.clear();
      }
      already.file = {
        ...already.file,
        edit: already.file.edit || edit,
        wait: edit || wait ? wait : already.file.wait,
        opened: (already.file.opened ?? 0) + 1,
        // Kept stays kept, and opening one for good keeps it.
        preview: (already.file.preview && preview) || undefined,
        at,
      };
      this.emit("change");
      return wait ? new Promise((resolve) => already.waiters.add(resolve)) : Promise.resolve();
    }

    const free = () => list.filter((open) => open.waiters.size === 0 && open.unsaved.size === 0);
    // The one passing file gives way to the next.
    const passing = preview ? free().find((open) => open.file.preview) : undefined;
    if (passing) {
      list.splice(list.indexOf(passing), 1);
      this.letGo(passing);
    }

    if (list.length >= MAX_FILES) {
      const oldest = free().sort((a, b) => a.used - b.used)[0];
      if (oldest) {
        list.splice(list.indexOf(oldest), 1);
        this.letGo(oldest);
      }
    }
    const open: OpenEntry = {
      file: { id: randomUUID().slice(0, 8), path: file, edit, wait, ...(preview && { preview }), ...(at && { at }) },
      listeners: new Set(),
      waiters: new Set(),
      unsaved: new Set(),
      used: ++this.fileUses,
    };
    list.push(open);
    this.emit("change");

    return wait ? new Promise((resolve) => open.waiters.add(resolve)) : Promise.resolve();
  }

  /** One of the tab's open files: `fileId`, or else the latest to open (all an older UI knows of). */
  private openEntry(tabId: string, fileId?: string): OpenEntry | undefined {
    const list = this.files.get(tabId);
    return fileId ? list?.find((open) => open.file.id === fileId) : list?.at(-1);
  }

  private isOpen(tabId: string, open: OpenEntry) {
    return !!this.files.get(tabId)?.includes(open);
  }

  /**
   * Where the tab's shell is, as last polled; or with `now`, where it is
   * this moment (an `lsof`), for a path typed just after a `cd`.
   */
  async tabCwd(tabId: string, { now = false } = {}): Promise<string | null> {
    const polled = this.cwds.get(tabId);
    if (!now && polled) return polled;
    return (await this.panes.get(tabId)?.cwd()) ?? polled ?? null;
  }

  /**
   * Follows an open file: as it is now, then each change on disk, until
   * `stop`. `unsaved` is whether this watcher has changes it hasn't saved.
   */
  watchFile(tabId: string, fileId: string | undefined, listener: FileListener): { stop: () => void; unsaved: (unsaved: boolean) => void } {
    const open = this.openEntry(tabId, fileId);
    if (!open) return { stop: () => {}, unsaved: () => {} };

    open.listeners.add(listener);
    this.followFile(tabId, open);
    void readForPanel(open.file.path).then((contents) => {
      if (this.isOpen(tabId, open) && open.listeners.has(listener)) listener({ id: open.file.id, ...contents });
    });

    return {
      stop: () => {
        open.listeners.delete(listener);
        open.unsaved.delete(listener);
        this.followFile(tabId, open);
      },
      unsaved: (unsaved) => {
        if (unsaved) {
          open.unsaved.add(listener);
          this.keepFile(tabId, open.file.id);
        } else {
          open.unsaved.delete(listener);
        }
      },
    };
  }

  async saveFile(tabId: string, fileId: string | undefined, content: string, mtime: number | null, force?: boolean) {
    const open = this.openEntry(tabId, fileId);
    if (!open) return { error: "The file was closed." };
    return writeFromPanel(open.file.path, content, mtime, force);
  }

  /** A passing file stays, past the next one opening: you double-clicked it, or changed it. */
  keepFile(tabId: string, fileId: string) {
    const open = this.openEntry(tabId, fileId);
    if (!open?.file.preview) return;
    open.file = { ...open.file, preview: undefined };
    this.emit("change");
  }

  /** Closes one of the tab's files, and lets whatever waited on it go. */
  closeFile(tabId: string, fileId?: string) {
    const open = this.openEntry(tabId, fileId);
    const list = this.files.get(tabId);
    if (!open || !list) return;

    list.splice(list.indexOf(open), 1);
    if (list.length === 0) this.files.delete(tabId);
    this.letGo(open);
    this.emit("change");
  }

  /** Closes every file in the tab's panel. */
  private closeFiles(tabId: string) {
    for (const open of this.files.get(tabId) ?? []) this.letGo(open);
    this.files.delete(tabId);
  }

  /** Stops watching a file that's closing, and lets whatever waited on it go. */
  private letGo(open: OpenEntry) {
    if (open.onDisk) fs.unwatchFile(open.file.path, open.onDisk);
    open.onDisk = undefined;
    for (const resolve of open.waiters) resolve();
  }

  /** Watches an open file on disk only while someone here watches it, and tells them each change. */
  private followFile(tabId: string, open: OpenEntry) {
    if (open.listeners.size === 0 || !this.isOpen(tabId, open)) {
      if (open.onDisk) fs.unwatchFile(open.file.path, open.onDisk);
      open.onDisk = undefined;
      return;
    }
    if (open.onDisk) return;

    // watchFile, not watch: editors and git replace files rather than
    // writing them, which a watch on the old one would miss.
    open.onDisk = () => {
      void readForPanel(open.file.path).then((contents) => {
        if (!this.isOpen(tabId, open)) return;
        for (const listener of open.listeners) listener({ id: open.file.id, ...contents });
      });
    };
    fs.watchFile(open.file.path, { interval: 500, persistent: false }, open.onDisk);
  }

  /**
   * What's being written in a tab's chat panel, from whichever window, so
   * every window (a Mac's, the iOS app's) has it; saved with the tab. Not in
   * `state`, which would go to every window on every keystroke.
   */
  setDraft(tabId: string, text: string) {
    if (!this.panes.has(tabId)) return;
    if (text) this.drafts.set(tabId, text);
    else this.drafts.delete(tabId);
    this.emit("draft");
  }

  /** Every tab's draft, "" for one with none. */
  getDrafts(): [string, string][] {
    return [...this.panes.keys()].map((tabId) => [tabId, this.drafts.get(tabId) ?? ""]);
  }

  /** Shows a web page in the tab's panel, in place of any it had. */
  openPage(tabId: string, url: string, { fill }: { fill?: boolean } = {}) {
    if (!this.panes.has(tabId)) return;
    this.pages.set(tabId, { id: randomUUID().slice(0, 8), url, ...(fill ? { fill } : {}) });
    this.emit("change");
  }

  /** Where the page has gone since (links, back), so a restore reopens it there. */
  pageNavigated(tabId: string, url: string) {
    const page = this.pages.get(tabId);
    if (!page || page.url === url || !/^https?:\/\//i.test(url)) return;
    // The same page (same id), so the panel doesn't load it again.
    this.pages.set(tabId, { ...page, url });
    this.emit("change");
  }

  closePage(tabId: string) {
    const page = this.pages.get(tabId);
    if (!page) return;
    this.remember({ kind: "page", tabId, url: page.url });
    this.pages.delete(tabId);
    this.emit("change");
  }

  /** Ends every pane. For tests; the real daemon just exits. */
  /**
   * Ends every pane, resolving once they've all exited (zsh writes its
   * history as it goes, into a home a test is about to delete) or `wait`
   * has passed, for one that ignores the hangup.
   */
  killAll(wait = 2000): Promise<void> {
    this.stopping = true;
    for (const chat of this.chats.values()) chat.transcript?.close();
    for (const background of this.backgrounds.values()) background.close();
    for (const tabId of [...this.files.keys()]) this.closeFiles(tabId);
    for (const timer of [...this.pendingDone.values(), ...[...this.pendingWaiting.values()].map((each) => each.timer)]) clearTimeout(timer);
    const exited = [...this.panes.values()].map((pane) => new Promise<void>((resolve) => pane.once("exit", () => resolve())));
    for (const pane of this.panes.values()) pane.kill();
    return Promise.race([Promise.all(exited).then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, wait).unref())]);
  }

  private getTab(id: string): Tab {
    const agent = this.agents.get(id);
    return {
      id,
      // Its history file's name, which a restore gives back to it.
      key: this.historyIds.get(id),
      title: this.panes.get(id)?.displayTitle ?? "",
      cwd: this.cwds.get(id) ?? null,
      agent: agent && this.restoredSessions.has(id) ? { ...agent, restored: true } : (agent ?? null),
      running: this.panes.get(id)?.running() ?? null,
      kept: this.keeps.has(id) || !!this.resumableSession(id),
      file: this.files.get(id)?.at(-1)?.file,
      files: this.files.get(id)?.map((open) => open.file),
      page: this.pages.get(id),
      background: this.backgrounds.get(id)?.counts(),
    };
  }

  private removeTab(tabId: string) {
    // Closed for good, not just stopping with the daemon: its history goes.
    const historyId = this.historyIds.get(tabId);
    this.historyIds.delete(tabId);
    // Unless ⌘⇧T could bring it back.
    if (historyId && !this.stopping && !this.historyInUse(historyId)) fs.rmSync(this.historyFile(historyId), { force: true });
    this.keeps.delete(tabId);
    clearTimeout(this.pendingDone.get(tabId));
    this.pendingDone.delete(tabId);
    this.cancelWaiting(tabId);
    this.panes.delete(tabId);
    this.agents.delete(tabId);
    this.sessions.delete(tabId);
    this.codexLookups.delete(tabId);
    this.codexTitled.delete(tabId);
    this.restoredSessions.delete(tabId);
    this.chats.get(tabId)?.transcript?.close();
    this.chats.delete(tabId);
    this.closeFiles(tabId);
    this.pages.delete(tabId);
    this.drafts.delete(tabId);
    this.backgrounds.get(tabId)?.close();
    this.backgrounds.delete(tabId);
    this.cwds.delete(tabId);

    const workspace = this.workspaces.find((w) => w.tabIds.includes(tabId));
    if (workspace) {
      const index = workspace.tabIds.indexOf(tabId);
      workspace.tabIds.splice(index, 1);

      if (workspace.activeTabId === tabId) {
        // Like closing a browser tab: land on its right-hand neighbor.
        workspace.activeTabId = workspace.tabIds[Math.min(index, workspace.tabIds.length - 1)] ?? null;
      }

      if (workspace.tabIds.length === 0) this.removeWorkspace(workspace.id);
    }

    this.emit("change");
  }

  private removeWorkspace(workspaceId: string) {
    const index = this.workspaces.findIndex((w) => w.id === workspaceId);
    if (index === -1) return;

    this.workspaces.splice(index, 1);

    if (this.activeWorkspaceId === workspaceId) {
      this.activeWorkspaceId = this.workspaces[Math.min(index, this.workspaces.length - 1)]?.id ?? null;
    }

    // Nothing to see in no workspaces at all, so closing the last starts afresh.
    if (this.workspaces.length === 0 && !this.stopping) this.createWorkspace();
  }

  private findWorkspace(workspaceId: string): WorkspaceRecord | undefined {
    return this.workspaces.find((w) => w.id === workspaceId);
  }
}

// Agents' title glyphs while working: Claude Code's half circles (braille in
// older versions), Codex's braille. Claude Code's ✳ when idle; Codex's title
// just loses the glyph.
const WORKING_TITLE = /^[◐◑◒◓\u2800-\u28ff]/u;
const CLAUDE_IDLE_TITLE = /^✳/u;
const CODEX_ASKING_TITLE = /^\[ [.!] \] Action Required/;

/** The working directory of each process, by pid, in one `lsof` call. */
function shellCwds(pids: number[]): Promise<Map<number, string>> {
  return new Promise((resolve) => {
    execFile("lsof", ["-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"], (_error, stdout) => {
      // lsof exits non-zero if any pid is gone, but still reports the rest.
      const cwds = new Map<number, string>();
      let pid = 0;
      for (const line of (stdout ?? "").split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        else if (line.startsWith("n") && pid) cwds.set(pid, line.slice(1));
      }
      resolve(cwds);
    });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function shortId(): string {
  return randomUUID().slice(0, 8);
}
