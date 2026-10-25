import { SerializeAddon } from "@xterm/addon-serialize";
import headless from "@xterm/headless";
import { execFile } from "child_process";
import { EventEmitter } from "events";
import * as pty from "node-pty";
import path from "path";

const { Terminal } = headless;

const SCROLLBACK = 10_000;

/** Startup files that mark prompts and commands in zsh (see .zshenv there). */
const ZSH_INTEGRATION = path.resolve(import.meta.dirname, "../shell/zsh");

/** Someone watching a pane: in practice, one UI connection. */
export type PaneViewer = {
  /** The screen as VT sequences, at the pane's size. */
  snapshot(data: string, cols: number, rows: number): void;
  output(data: string): void;
  /** The pane took another viewer's size (another screen is in use), from here on in the output. */
  size?(cols: number, rows: number): void;
};

/**
 * Variables we must not pass down from whatever launched the daemon. When the
 * UI is started from inside another terminal (cmux, Ghostty, Claude Code
 * itself), these would make programs in our panes think they're running
 * there instead: cmux's hooks would report to cmux, and `claude` would refuse
 * to start inside "another" Claude Code session.
 */
const INHERITED_ENV_BLOCKLIST = [
  /^CMUX_/,
  /^GHOSTTY_/,
  /^TERM_PROGRAM/,
  // Everything Claude Code marks its own subprocesses with. Inherited, it
  // makes a `claude` in our pane a child session that saves no transcript (so
  // can't be resumed), or one that refuses to start inside "another" one.
  // Settings you keep in your shell profile come back with the login shell.
  /^CLAUDE/,
  // Miks's own: each pane sets its own MIKS_PANE_ID and MIKS_SOCKET, and the
  // dev build's MIKS_UI_URL would point any Miks.app launched from a pane at
  // the dev server.
  /^MIKS_/,
  // The daemon runs as Miks.app's binary in Node mode; a shell inheriting
  // this would make every Electron app it launched (VS Code's `code`, say)
  // start as plain Node instead.
  /^ELECTRON_/,
];

/**
 * One shell in a PTY, plus a headless terminal emulator that sees every byte
 * it prints. The emulator is what makes reattaching work: a new viewer gets
 * the emulator's current screen serialized as VT sequences, then the live
 * stream from exactly that point on.
 *
 * Only viewers answer terminal queries (cursor position, device attributes):
 * the headless emulator's replies are dropped, the same way VS Code's pty
 * host does it. With several attached (another Mac's window, a phone), only
 * the one in use's answer reaches the program (`reply`): a second answer
 * came after the program had stopped reading, and landed in the shell.
 */
export class Pane extends EventEmitter<{
  /** The new title, then the one it replaced. */
  title: [string, string];
  exit: [number];
}> {
  readonly id: string;
  /** The last title a program set (OSC 0/2), and which program it was. */
  title: string;
  private titleSetBy: string | null = null;
  /** The program in front, as of the last `pollForeground`. */
  private foreground: string;
  /** What the pane started with: its shell, which isn't worth warning about. */
  private readonly shell: string;
  /** Whether the program asked to hear about color scheme changes (DEC mode 2031). */
  private reportsColorScheme = false;
  /**
   * Whether mouse reports use SGR encoding (DEC mode 1006). The serializer
   * restores which mouse events a program asked for, but not this, so a
   * reattached UI would send Claude Code reports it can't read.
   */
  private sgrMouse = false;
  private dark = true;

  private readonly pty: pty.IPty;
  private readonly terminal: InstanceType<typeof Terminal>;
  private readonly serializer = new SerializeAddon();
  private readonly viewers = new Set<PaneViewer>();
  /** Viewers whose snapshot is being taken, and the output they'll need after it. */
  private readonly attaching = new Map<PaneViewer, string[]>();
  /** The viewer last to size the pane or type into it: the screen in use. */
  private inUse: PaneViewer | null = null;

  constructor({
    id,
    cwd,
    env,
    command = [process.env.SHELL || "/bin/zsh", "-l"],
    dark = true,
    cols = 80,
    rows = 24,
  }: {
    id: string;
    cwd: string;
    env: Record<string, string>;
    /** What to run; a login shell unless told otherwise (tests are). */
    command?: string[];
    /** Whether the UI is in dark mode, for color scheme reports. */
    dark?: boolean;
    cols?: number;
    rows?: number;
  }) {
    super();
    this.id = id;
    this.dark = dark;

    const [file, ...args] = command;
    this.title = path.basename(file);
    this.foreground = this.title;
    this.shell = this.title;

    this.terminal = new Terminal({
      cols,
      rows,
      scrollback: SCROLLBACK,
      allowProposedApi: true,
    });
    this.terminal.loadAddon(this.serializer as any);
    // Color scheme reporting, which xterm.js doesn't do itself. Programs like
    // Claude Code switch between their light and dark themes with it: they
    // set mode 2031 to be told when the scheme changes, and ask with CSI ? 996 n.
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(1006)) this.sgrMouse = true;
      if (params.includes(2031) && !this.reportsColorScheme) {
        this.reportsColorScheme = true;
        // Say where things stand now, not just when they change: Claude Code
        // turns this on at startup and never asks.
        this.reportColorScheme();
      }
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(1006)) this.sgrMouse = false;
      if (params.includes(2031)) this.reportsColorScheme = false;
      return false;
    });
    this.terminal.parser.registerEscHandler({ final: "c" }, () => {
      this.sgrMouse = false;
      return false;
    });
    this.terminal.parser.registerCsiHandler({ prefix: "?", final: "n" }, (params) => {
      if (params[0] !== 996) return false;
      this.reportColorScheme();
      return true;
    });

    this.terminal.onTitleChange((title) => {
      const previous = this.title;
      this.title = title;
      this.titleSetBy = this.pty.process;
      this.foreground = this.titleSetBy;
      this.emit("title", title, previous);
    });

    this.pty = pty.spawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: { ...paneEnv(), ...shellIntegrationEnv(file), ...env },
    });

    this.pty.onData((data) => {
      this.terminal.write(data);
      for (const viewer of this.viewers) viewer.output(data);
      for (const pending of this.attaching.values()) pending.push(data);
    });

    this.pty.onExit(({ exitCode }) => {
      this.viewers.clear();
      this.attaching.clear();
      this.inUse = null;
      this.terminal.dispose();
      this.emit("exit", exitCode);
    });
  }

  /** Without a size, the pane keeps its own and the viewer adopts it. */
  attach(viewer: PaneViewer, size?: { cols: number; rows: number }) {
    this.detach(viewer);
    if (size) this.resize(size.cols, size.rows, viewer);

    // The emulator parses writes asynchronously, so the snapshot has to wait
    // until it has caught up with everything written so far. An empty write's
    // callback fires right after the bytes queued ahead of it are parsed.
    // Anything the PTY prints in the meantime is held for this viewer, since
    // it'll be missing from the snapshot.
    this.attaching.set(viewer, []);
    this.terminal.write("", () => {
      const pending = this.attaching.get(viewer);
      if (!pending) return; // Detached (or exited) while we waited.

      this.attaching.delete(viewer);
      const screen = this.serializer.serialize({ scrollback: SCROLLBACK }) + (this.sgrMouse ? "\x1b[?1006h" : "");
      viewer.snapshot(screen, this.terminal.cols, this.terminal.rows);
      for (const data of pending) viewer.output(data);
      this.viewers.add(viewer);
    });
  }

  detach(viewer: PaneViewer) {
    this.viewers.delete(viewer);
    this.attaching.delete(viewer);
    if (this.inUse === viewer) this.inUse = null;
  }

  /** Typing, or anything else sent as if typed; `from` is then in use. */
  write(data: string, from?: PaneViewer) {
    if (from) this.inUse = from;
    this.pty.write(data);
  }

  /**
   * A viewer's terminal answering a query, passed on only from the one in
   * use, or with none in use, the first attached: every viewer answers, and
   * the program reads one answer.
   */
  reply(data: string, from: PaneViewer) {
    const inUse = this.inUse && this.viewers.has(this.inUse) ? this.inUse : this.viewers.values().next().value;
    if (from === inUse) this.pty.write(data);
  }

  /**
   * The size of the screen in use (`by`'s): every other viewer hears it, so
   * it can draw at that size until its own screen is used again. Not `by`,
   * which may already have moved on (a window edge being dragged).
   */
  resize(cols: number, rows: number, by?: PaneViewer) {
    if (by) this.inUse = by;
    cols = Math.max(2, Math.floor(cols));
    rows = Math.max(1, Math.floor(rows));
    if (cols === this.terminal.cols && rows === this.terminal.rows) return;

    this.terminal.resize(cols, rows);
    this.pty.resize(cols, rows);
    for (const viewer of this.viewers) if (viewer !== by) viewer.size?.(cols, rows);
  }

  /**
   * Clears the screen and scrollback but the cursor's line, as the UI's
   * terminal just did (⌘K), so reattaching doesn't bring it all back.
   */
  clear() {
    this.terminal.clear();
  }

  kill() {
    this.pty.kill("SIGHUP");
  }

  /**
   * What the tab should be called. A program's own title while that program
   * is still in front (Claude Code's session topic, say); otherwise the name
   * of whatever is, the way Terminal.app does it. Plain zsh and most programs
   * (top, vim) never set a title, and one left by a program that has since
   * exited is stale.
   */
  get displayTitle(): string {
    return this.titleSetBy && this.titleSetBy === this.foreground ? this.title : this.foreground;
  }

  /** Checks which program is in front. Returns whether that changed. */
  pollForeground(): boolean {
    const foreground = this.pty.process;
    if (!foreground || foreground === this.foreground) return false;
    this.foreground = foreground;
    return true;
  }

  /** The program in front, unless it's the shell: what quitting would stop. */
  running(): string | null {
    // Right after spawning, the process is still named by its full path.
    const foreground = path.basename(this.pty.process || this.foreground);
    return foreground === this.shell ? null : foreground;
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Follows the UI's light or dark appearance, telling the program if it asked. */
  setDark(dark: boolean) {
    if (dark === this.dark) return;
    this.dark = dark;
    if (this.reportsColorScheme) this.reportColorScheme();
  }

  private reportColorScheme() {
    this.pty.write(`\x1b[?997;${this.dark ? 1 : 2}n`);
  }

  /** The shell's working directory, or null if it can't be read. */
  cwd(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile("lsof", ["-a", "-p", String(this.pty.pid), "-d", "cwd", "-Fn"], (error, stdout) => {
        const line = stdout?.split("\n").find((l) => l.startsWith("n"));
        resolve(!error && line ? line.slice(1) : null);
      });
    });
  }
}

/** zsh reads Miks's startup files, which read yours. Other shells go without. */
function shellIntegrationEnv(file: string): Record<string, string> {
  if (path.basename(file) !== "zsh") return {};
  // Without a ZDOTDIR of yours, they read from the pane's $HOME.
  return { ZDOTDIR: ZSH_INTEGRATION, ...(process.env.ZDOTDIR ? { MIKS_USER_ZDOTDIR: process.env.ZDOTDIR } : {}) };
}

function paneEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (INHERITED_ENV_BLOCKLIST.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }

  return {
    ...env,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "Miks",
  };
}
