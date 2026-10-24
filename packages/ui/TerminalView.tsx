import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { ModalContext, type ModalContextValue } from "crosswing/modals/context";
import { displayPath } from "miks/shared/settings";
import { DragEvent, HTMLAttributes, use, useEffect, useRef } from "react";
import { styled } from "styled-components";
import { safeArea } from "crosswing/safearea";
import { daemon, isRemote } from "./daemon";
import { autoFocus, getSettings, useSettings } from "./settings";
import { trackCommands } from "./commandMarks";
import { handleClipboardWrites } from "./osc52";
import { handlePathLinks } from "./pathLinks";
import { withModifiers } from "./keys";
import { handleWheel } from "./wheel";
import { openLink } from "./links";

/**
 * One pane's terminal. Every tab's terminal stays mounted (stacked, with only
 * the active one visible) so each keeps its size, scrollback, and stream; the
 * daemon owns the real state, so this is a view that can be rebuilt anytime.
 */
export function TerminalView({
  tabId,
  active,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  tabId: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<View | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const dark = useMatchMedia("(prefers-color-scheme: dark)");
  const { showToast } = use(ModalContext);
  const { fontSize, optionAsMeta } = useSettings();

  useEffect(() => {
    const terminal = new Terminal({
      fontFamily: `"SF Mono", Menlo, Monaco, monospace`,
      fontSize: getSettings().fontSize,
      lineHeight: 1.15,
      scrollback: 10_000,
      allowProposedApi: true,
      macOptionClickForcesSelection: true,
      macOptionIsMeta: getSettings().optionAsMeta,
      theme: dark ? darkTheme : lightTheme,
    });
    const fit = new FitAddon();
    const commands = trackCommands(terminal);
    const view: View = { tabId, terminal, fit, commands, elsewhere: false };
    viewRef.current = view;
    views.set(tabId, view);

    terminal.loadAddon(fit);
    // ⌃V in a window on another Mac: this Mac's clipboard image, for Claude.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !isRemote() || !isPasteImageKey(event)) return true;
      event.preventDefault();
      void pasteClipboardImage(tabId);
      return false;
    });
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.loadAddon(new WebLinksAddon((_event, uri) => openLink(uri, tabId)));
    const pathLinks = handlePathLinks(terminal, tabId);
    terminal.open(containerRef.current!);
    const wheel = handleWheel(terminal, (data) => daemon.send({ type: "input", tabId, data }));
    handleClipboardWrites(terminal, (text) => window.miks?.copy(text));

    const unstream = daemon.stream(tabId, (event) => {
      // Another window (on another Mac, or device) is in use and sized the
      // pane: draw at its size, from this point in the output, until this
      // one is used again.
      if (event.type === "size") {
        if (event.cols !== terminal.cols || event.rows !== terminal.rows) terminal.resize(event.cols, event.rows);
        view.elsewhere = true;
        return;
      }
      if (event.type === "snapshot") {
        terminal.reset();
        wheel.reset();
        // A tab that isn't on screen takes the pane's size as it is.
        if (event.cols !== terminal.cols || event.rows !== terminal.rows) {
          terminal.resize(event.cols, event.rows);
        }
      }
      // Once it's parsed, where the cursor is: the snapshot carries no marks.
      if (event.type === "snapshot") terminal.write(event.data, () => commands.attached());
      else terminal.write(event.data);
      if (event.type === "output") for (const watcher of outputWatchers.get(tabId) ?? []) watcher(event.data);
    });

    // Only the tab on screen decides its pane's size, and only once its
    // renderer is in place: the WebGL and DOM renderers measure characters
    // differently, and every size change is a SIGWINCH that makes full-screen
    // programs redraw.
    const attach = () => {
      if (activeRef.current) daemon.send({ type: "attach", tabId, cols: terminal.cols, rows: terminal.rows });
      else daemon.send({ type: "attach", tabId });
    };
    const unconnect = daemon.onConnect(attach);

    // With the key bar's Ctrl, if it's on (keys.ts).
    const input = terminal.onData((data) => daemon.send({ type: "input", tabId, data: withModifiers(data) }));
    const binary = terminal.onBinary((data) => daemon.send({ type: "input", tabId, data }));

    if (activeRef.current) prepareActive(terminal, fit);
    if (daemon.connected) attach();

    // Adopting the pane's size from a snapshot echoes it back here too, which
    // the daemon ignores since nothing changed.
    // The daemon hears about a new size once it settles. Dragging the sidebar
    // or the window edge refits on every frame, and each size the pane takes
    // is a SIGWINCH that makes Claude Code or vim redraw.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const resize = terminal.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => daemon.send({ type: "resize", tabId, cols, rows }), 100);
    });

    const observer = new ResizeObserver(() => {
      if (activeRef.current) fit.fit();
    });
    observer.observe(containerRef.current!);

    return () => {
      observer.disconnect();
      input.dispose();
      binary.dispose();
      resize.dispose();
      pathLinks.dispose();
      if (resizeTimer) clearTimeout(resizeTimer);
      unconnect();
      unstream();
      daemon.send({ type: "detach", tabId });
      webglAddons.get(terminal)?.dispose();
      terminal.dispose();
      viewRef.current = null;
      if (views.get(tabId) === view) views.delete(tabId);
    };
    // The theme is applied below, without rebuilding the terminal.
  }, [tabId]);

  useEffect(() => {
    if (viewRef.current) viewRef.current.terminal.options.theme = dark ? darkTheme : lightTheme;
  }, [dark]);

  useEffect(() => {
    if (viewRef.current) viewRef.current.terminal.options.macOptionIsMeta = optionAsMeta;
  }, [optionAsMeta]);

  // A new font size changes how many cells fit, so the visible terminal
  // refits (resizing its pane); hidden ones refit when they come on screen.
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.terminal.options.fontSize === fontSize) return;

    view.terminal.options.fontSize = fontSize;
    if (activeRef.current) view.fit.fit();
  }, [fontSize]);

  // Coming on screen: switch to WebGL and fit to the area, which resizes the
  // pane only if the area actually changed while the tab was hidden.
  useEffect(() => {
    const view = viewRef.current;
    if (!active || !view) return;

    prepareActive(view.terminal, view.fit);
    if (autoFocus()) view.terminal.focus();
    activeView = view;

    // The last screen used decides the pane's size: coming back to this
    // window (focusing it, or a phone's page showing again), or the first key,
    // click or tap in it after another took the pane, takes it back at this
    // window's size, refitted from the one it was drawing at.
    const takeOver = () => {
      view.elsewhere = false;
      view.fit.fit();
      daemon.send({ type: "resize", tabId: view.tabId, cols: view.terminal.cols, rows: view.terminal.rows });
    };
    const takeBack = () => {
      if (view.elsewhere) takeOver();
    };
    const shown = () => {
      if (document.visibilityState === "visible") takeOver();
    };
    window.addEventListener("focus", takeOver);
    document.addEventListener("visibilitychange", shown);
    // Capturing, so the pane has this size before the key that follows.
    window.addEventListener("keydown", takeBack, { capture: true });
    window.addEventListener("pointerdown", takeBack, { capture: true });

    return () => {
      window.removeEventListener("focus", takeOver);
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("keydown", takeBack, { capture: true });
      window.removeEventListener("pointerdown", takeBack, { capture: true });
      if (activeView === view) activeView = null;
      webglAddons.get(view.terminal)?.dispose();
      webglAddons.delete(view.terminal);
    };
  }, [active]);

  async function onDrop(event: DragEvent<HTMLDivElement>) {
    const text = await droppedText(event, tabId, showToast);
    if (!text) return;

    viewRef.current?.terminal.paste(text);
    viewRef.current?.terminal.focus();
  }

  return (
    <StyledTerminalView ref={containerRef} data-active={active} onDragOver={onDragOver} onDrop={onDrop} {...rest} />
  );
}

export function onDragOver(event: DragEvent) {
  event.preventDefault();
  // Finder's "+": what it does with ⌥ held, and never a move.
  event.dataTransfer.dropEffect = "copy";
}

/**
 * What dropping files on a tab types: their paths, escaped the way
 * Terminal.app does it, which is also how Claude Code recognizes a dropped
 * image. On a window on another Mac they're copied to a temporary folder
 * there first. With ⌥ held they're copied into the tab's folder instead (on
 * either Mac), with a toast, and nothing is typed.
 */
export async function droppedText(
  event: DragEvent,
  tabId: string,
  showToast: ModalContextValue["showToast"],
): Promise<string | null> {
  event.preventDefault();
  const altKey = event.altKey;
  const files = Array.from(event.dataTransfer.files);
  const dropped = files.map((file) => window.miks?.pathForFile(file)).filter(Boolean) as string[];
  // A device without the Mac's files (the iOS app): sent over.
  if (dropped.length === 0 && files.length > 0) return attachedText(files, tabId, showToast);
  if (dropped.length === 0 || !window.miks) return null;

  if (altKey) {
    const saved = await window.miks.sendFiles(tabId, dropped, "cwd");
    if (saved.length === 0) {
      showToast({ title: "Couldn't copy into this folder", destructive: true });
      return null;
    }
    const folder = saved[0].slice(0, saved[0].lastIndexOf("/"));
    const { hidePathPrefix } = getSettings();
    showToast({
      title: saved.length === 1 ? `Copied ${saved[0].slice(folder.length + 1)}` : `Copied ${saved.length} items`,
      message: `Into ${displayPath(folder, hidePathPrefix, daemon.getSnapshot().state?.home ?? null)}`,
    });
    return null;
  }

  const paths = isRemote() ? await window.miks.sendFiles(tabId, dropped, "tmp") : dropped;
  return paths.length > 0 ? paths.map(shellEscape).join(" ") + " " : null;
}

/**
 * Files to type, as paths on the tab's Mac, as a drop's are (Claude Code
 * attaches an image by its path): their own on this Mac, copies on a
 * remote, and from a device without the Mac's files (the iOS app's
 * attachments), copies the daemon makes in its tmpdir.
 */
export async function attachedText(files: File[], tabId: string, showToast: ModalContextValue["showToast"]): Promise<string | null> {
  const local = files.map((file) => window.miks?.pathForFile(file)).filter(Boolean) as string[];
  let paths: string[];
  if (local.length === files.length && window.miks) {
    paths = isRemote() ? await window.miks.sendFiles(tabId, local, "tmp") : local;
  } else {
    const sent = await Promise.all(files.map((file) => daemon.sendFile(file)));
    const failed = sent.find((result) => result.error);
    if (failed) showToast({ title: "Couldn't attach a file", message: failed.error, destructive: true });
    paths = sent.flatMap((result) => (result.path ? [result.path] : []));
  }
  return paths.length > 0 ? paths.map(shellEscape).join(" ") + " " : null;
}

function shellEscape(path: string): string {
  // Only ASCII characters the shell treats specially; "é" stays as it is.
  return path.replace(/[\s!"#$&'()*;<>?[\\\]^`{|}~]/g, "\\$&");
}

type View = {
  tabId: string;
  terminal: Terminal;
  fit: FitAddon;
  commands: ReturnType<typeof trackCommands>;
  /** Drawn at another screen's size, for the one in use, until this one is used again. */
  elsewhere: boolean;
};

let activeView: View | null = null;
const views = new Map<string, View>();

export type Key = "escape" | "tab" | "backtab" | "up" | "down" | "left" | "right" | "|" | "~" | "/" | "-";

/** A key from the key bar (KeyBar.tsx), into the terminal on screen: arrows as its program wants them. */
export function typeKey(key: Key) {
  const view = activeView;
  if (!view) return;
  const arrow = { up: "A", down: "B", right: "C", left: "D" }[key as string];
  const data = arrow
    ? `\x1b${view.terminal.modes.applicationCursorKeysMode ? "O" : "["}${arrow}`
    : key === "escape"
      ? "\x1b"
      : key === "tab"
        ? "\t"
        : key === "backtab"
          ? "\x1b[Z"
          : key;
  daemon.send({ type: "input", tabId: view.tabId, data });
}

/**
 * Types a message into the tab and presses Return, as the chat panel sends
 * one: pasted, so its newlines stay in the message, and Return a moment
 * later as a keystroke of its own, or Claude Code takes it as part of the
 * paste.
 */
export function sendToTerminal(tabId: string, text: string) {
  const view = views.get(tabId);
  if (!view) return;

  view.terminal.paste(text);
  setTimeout(() => daemon.send({ type: "input", tabId, data: "\r" }), 100);
}

/** What's waiting to see some text come out of each tab's program. */
const outputWatchers = new Map<string, Set<(data: string) => void>>();

/** The highest `[Image #N]` on the tab's screen: Claude Code's pasted images. */
function lastImageNumber(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  let highest = 0;
  for (let i = 0; i < buffer.length; i++) {
    for (const match of buffer.getLine(i)?.translateToString(true).matchAll(/\[Image #(\d+)\]/g) ?? []) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return highest;
}

/** Resolves true once the tab's program prints a new `[Image #N]`, false if it doesn't in time. */
function waitForNewImage(tabId: string, after: number, timeout: number): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = "";
    const watchers = outputWatchers.get(tabId) ?? new Set();
    outputWatchers.set(tabId, watchers);
    const finish = (found: boolean) => {
      clearTimeout(timer);
      watchers.delete(watch);
      resolve(found);
    };
    const watch = (data: string) => {
      // The text alone (Claude Code colors its tags), and a little of what
      // came before, for a tag split across writes.
      seen = (seen + data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")).slice(-200);
      for (const match of seen.matchAll(/\[Image #(\d+)\]/g)) if (Number(match[1]) > after) return finish(true);
    };
    const timer = setTimeout(() => finish(false), timeout);
    watchers.add(watch);
  });
}

/** ⌃V: Claude Code's own paste, of an image on the clipboard. */
export const isPasteImageKey = (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
  event.key === "v" && event.ctrlKey && !event.metaKey && !event.altKey;

/**
 * Pastes the clipboard's image into Claude Code's prompt in the tab. On this
 * Mac that's ⌃V, which Claude answers by reading the clipboard itself. On
 * another Mac's window it would read the wrong one, so the image goes over
 * and its path is typed, which Claude takes the way it takes a dropped image.
 * Resolves with whether there was an image.
 */
export async function pasteClipboardImage(tabId: string): Promise<boolean> {
  const bridge = window.miks;
  const result = (await bridge?.sendClipboardImage(tabId)) ?? { image: false };
  const view = views.get(tabId);
  if (result.path && view) {
    view.terminal.paste(shellEscape(result.path) + " ");
    return true;
  }

  // Nothing went over (no image, or no tunnel): ⌃V as it is. And once
  // Claude has put the image's tag in, a space after it, for what comes next.
  const before = view ? lastImageNumber(view.terminal) : 0;
  daemon.send({ type: "input", tabId, data: "\x16" });
  if (result.image) {
    void waitForNewImage(tabId, before, 3000).then((found) => found && daemon.send({ type: "input", tabId, data: " " }));
  }
  return result.image;
}

/** Interrupts what the tab's program is doing, as Escape would. */
export function sendEscape(tabId: string) {
  daemon.send({ type: "input", tabId, data: "\x1b" });
}

/** Gives the keyboard back to the terminal on screen (after a dialog, say). */
export function focusActiveTerminal() {
  if (autoFocus()) activeView?.terminal.focus();
}

/** Edit → Select last command (⌘⇧A): its prompt through its output. */
export function selectLastCommand() {
  activeView?.commands.selectLast();
}

/**
 * Edit → Clear to start (⌘K), as in Terminal.app: the screen and scrollback,
 * all but the line you're typing on. Not in full-screen programs, which own
 * their screen.
 */
export function clearActiveTerminal() {
  const view = activeView;
  if (!view || view.terminal.buffer.active.type !== "normal") return;
  view.terminal.clear();
  view.commands.cleared();
  daemon.send({ type: "clear", tabId: view.tabId });
}

/**
 * Only the visible terminal gets a WebGL renderer: Chromium caps how many
 * WebGL contexts a page can have, and hidden terminals don't need one.
 */
const webglAddons = new WeakMap<Terminal, WebglAddon>();

function prepareActive(terminal: Terminal, fit: FitAddon) {
  if (!webglAddons.has(terminal)) {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      webgl.dispose();
      webglAddons.delete(terminal);
    });
    terminal.loadAddon(webgl);
    webglAddons.set(terminal, webgl);
  }

  fit.fit();
}

export const StyledTerminalView = styled.div`
  position: absolute;
  inset: 8px ${safeArea.right()} ${safeArea.bottom()} ${safeArea.left("10px")};
  visibility: hidden;

  &[data-active="true"] {
    visibility: visible;
  }
`;

//
// Themes, after VS Code's default dark and light terminal colors.
//

export const TERMINAL_BACKGROUND = { dark: "#1a1b1e", light: "#ffffff" };

/**
 * The terminal's scroll bar (xterm.js's, from VS Code), for what scrolls
 * beside it: a square slider in its text's color. Always shown: Chromium
 * doesn't redraw one that shows on the scroller's :hover.
 */
export const terminalScrollbarCSS = () => `
  &::-webkit-scrollbar {
    width: 14px;
    height: 14px;
  }

  &::-webkit-scrollbar-track,
  &::-webkit-scrollbar-corner {
    background: transparent;
  }

  &::-webkit-scrollbar-thumb {
    background: rgba(51, 51, 51, 0.2);
  }
  &::-webkit-scrollbar-thumb:hover {
    background: rgba(51, 51, 51, 0.4);
  }
  &::-webkit-scrollbar-thumb:active {
    background: rgba(51, 51, 51, 0.5);
  }

  @media (prefers-color-scheme: dark) {
    &::-webkit-scrollbar-thumb {
      background: rgba(204, 204, 204, 0.2);
    }
    &::-webkit-scrollbar-thumb:hover {
      background: rgba(204, 204, 204, 0.4);
    }
    &::-webkit-scrollbar-thumb:active {
      background: rgba(204, 204, 204, 0.5);
    }
  }
`;

const darkTheme: ITheme = {
  background: TERMINAL_BACKGROUND.dark,
  foreground: "#cccccc",
  cursor: "#cccccc",
  selectionBackground: "#264f78",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
};

const lightTheme: ITheme = {
  background: TERMINAL_BACKGROUND.light,
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "#add6ff",
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};
