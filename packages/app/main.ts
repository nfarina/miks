import { spawn, spawnSync } from "child_process";
import crypto from "crypto";
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, screen, shell } from "electron";
import type { MenuItemConstructorOptions, WebContents } from "electron";
import fs from "fs";
import http from "http";
import path from "path";
import { connectDaemon as openDaemonSocket } from "miks/shared/connect";
import { logPath, miksHome, settingsPath as settingsFile, socketPath } from "miks/shared/paths";
import type { RunningProgram } from "miks/shared/protocol";
import { describeRunning } from "miks/shared/background";
import { DEFAULT_SETTINGS, type Remote, type Settings } from "miks/shared/settings";
import { API_HEADER, tailnetMacs } from "miks/shared/tailscale";
import os from "os";
import type { WebSocket } from "ws";
import { browsePartition, isBrowsePartition } from "./browse.ts";
import { syncClaudeHooks } from "./claudeHooks.ts";
import { checkRemote, remoteSocket, stopAllRemotes, stopRemote } from "./remotes.ts";
import { checkForUpdates, startUpdates, updateFromShell } from "./updates.ts";

// The Electron shell is deliberately thin: windows, a menu, and a pipe
// between each window and a daemon's Unix socket (which the renderer can't
// open itself). Every terminal lives in a daemon, so reloading a window leaves
// them all running. A window is on this Mac's daemon, or on a remote's,
// through its gateway on Tailscale (remotes.ts); one window per daemon.

// The repo in development; Contents/Resources/app inside Miks.app.
const root = path.resolve(import.meta.dirname, "../..");
const daemonMain = path.join(root, "packages/daemon/server/main.ts");
const iconPath = path.join(root, "packages/app/icon/icon.png");

//
// The daemon.
//

function connectOnce(socketFile = socketPath()): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = openDaemonSocket(socketFile);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

/**
 * Connects to this Mac's daemon, starting it first if nothing is listening,
 * or to a remote's, which is only ever started there.
 */
async function connectDaemon(remote: Remote | null): Promise<WebSocket> {
  if (remote) {
    await checkRemote(remote);
    try {
      return await connectOnce(await remoteSocket(remote));
    } catch {
      throw new Error(`Lost the connection to ${remote.name}. Reconnecting…`);
    }
  }

  try {
    return await connectOnce();
  } catch {
    // One start for every window reconnecting at once: another's would
    // replace the job, stopping the daemon this one started.
    starting ??= startDaemon().finally(() => (starting = undefined));
    await starting;
  }

  const deadline = Date.now() + 5000;
  while (true) {
    try {
      return await connectOnce();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

let starting: Promise<void> | undefined;

/** Starts this Mac's daemon, resolving once it answers (or 5s on). */
async function startDaemon() {
  fs.mkdirSync(miksHome(), { recursive: true, mode: 0o700 });

  // The daemon runs on our own helper as plain Node (node-pty's prebuilt
  // binary uses Node-API, so it loads in any Node), which needs nothing
  // installed. Apps launched from the Finder get a bare PATH, hence the
  // usual suspects.
  const label = `com.nfarina.miks.daemon.${crypto.createHash("sha1").update(miksHome()).digest("hex").slice(0, 8)}`;
  const env: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", MIKS_DAEMON_JOB: label };
  env.PATH = [env.PATH, "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(":");

  // A launchd job, not a child of ours, so it outlives us (that's the whole
  // point) as its own process. macOS holds what a process spawns to the app
  // that spawned it, for good: a daemon we spawned stays ours after we quit,
  // and the local network checks for its terminals, finding no such
  // process, failed at random. As its own process it's Miks Helper, with
  // permissions of its own.
  const plist = path.join(miksHome(), "daemon.plist");
  fs.writeFileSync(
    plist,
    plistXML({
      Label: label,
      ProgramArguments: [helperPath(), daemonMain, "serve"],
      EnvironmentVariables: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] != null)),
      StandardOutPath: logPath(),
      StandardErrorPath: logPath(),
      RunAtLoad: true,
      // Its terminals run whatever you run: no background throttling, and
      // nothing it spawns is killed when it exits (a restart's replacement).
      ProcessType: "Interactive",
      AbandonProcessGroup: true,
    }),
  );

  // Replacing any job from before, which may be another build's.
  const domain = `gui/${process.getuid?.()}`;
  spawnSync("launchctl", ["bootout", `${domain}/${label}`]);
  for (let attempt = 0; ; attempt++) {
    const result = spawnSync("launchctl", ["bootstrap", domain, plist], { encoding: "utf8" });
    if (result.status === 0) break;
    // A bootout finishes after it returns ("Input/output error" until then).
    if (attempt === 20) throw new Error(`Couldn't start the daemon: ${result.stderr.trim()}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  for (let i = 0; i < 50 && !(await daemonGet("/api/ping")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A launchd property list, for the values startDaemon uses. */
type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

function plistXML(dict: { [key: string]: PlistValue }): string {
  // Control characters aren't allowed in XML at all; one in any variable
  // would make the whole job fail to load.
  const escape = (text: string) =>
    text
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const value = (item: PlistValue): string =>
    typeof item === "boolean"
      ? `<${item}/>`
      : typeof item === "string"
        ? `<string>${escape(item)}</string>`
        : Array.isArray(item)
          ? `<array>${item.map(value).join("")}</array>`
          : `<dict>${Object.entries(item)
              .map(([key, inner]) => `<key>${escape(key)}</key>${value(inner)}`)
              .join("")}</dict>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n` +
    `<plist version="1.0">${value(dict)}</plist>\n`
  );
}

/**
 * The plain helper inside our bundle ("Miks Helper", or "Electron Helper" in
 * development), which the daemon runs on. Not our own executable: macOS
 * takes launching an app's main binary as launching the app, and bounces it
 * in the Dock waiting for a window that never comes. The helper is
 * LSUIElement, so it has no Dock icon at all.
 */
function helperPath(): string {
  const name = path.basename(process.execPath);
  const helper = path.join(
    path.dirname(process.execPath),
    `../Frameworks/${name} Helper.app/Contents/MacOS/${name} Helper`,
  );
  return fs.existsSync(helper) ? helper : process.execPath;
}

/**
 * One daemon connection per window, replaced whenever the window's page
 * (re)loads so the daemon never streams to terminals that no longer exist.
 */
const links = new Map<WebContents, WebSocket>();
/** Which remote each window is on, by id; null for this Mac. */
const windowRemotes = new Map<WebContents, string | null>();
/** Remote windows try again on their own; this is when, for each. */
const retries = new Map<WebContents, NodeJS.Timeout>();

const remoteFor = (contents: WebContents): Remote | null => {
  const id = windowRemotes.get(contents);
  return (id && settings.remotes.find((remote) => remote.id === id)) || null;
};

ipcMain.on("miks:connect", (event) => linkWindow(event.sender));

async function linkWindow(contents: WebContents) {
  links.get(contents)?.close();
  links.delete(contents);
  clearTimeout(retries.get(contents));

  const remote = remoteFor(contents);
  const retry = (error: string) => {
    if (contents.isDestroyed()) return;
    contents.send("miks:status", { connected: false, error, retrying: !!remote });
    if (remote) retries.set(contents, setTimeout(() => linkWindow(contents), 3000));
  };

  if (windowRemotes.get(contents) && !remote) {
    return contents.send("miks:status", { connected: false, error: "This machine was removed in Settings." });
  }

  let socket: WebSocket;
  try {
    socket = await connectDaemon(remote);
  } catch (error) {
    return retry(error instanceof Error ? error.message : String(error));
  }

  if (contents.isDestroyed()) return socket.close();
  links.set(contents, socket);

  // Told so before a restart, from any window: another Mac's, or the iOS app.
  let restarting = false;
  socket.on("message", (data) => {
    const message = data.toString();
    if (message === '{"type":"restarting"}') restarting = true;
    if (!contents.isDestroyed()) contents.send("miks:message", message);
  });
  socket.on("close", () => {
    if (links.get(contents) !== socket) return;
    links.delete(contents);
    if (remote) retry(`Lost the connection to ${remote.name}. Reconnecting…`);
    else if (restarting) awaitRestart(contents);
    else if (!contents.isDestroyed()) contents.send("miks:status", { connected: false });
  });

  contents.send("miks:status", { connected: true });
  if (!remote) {
    // This Mac's Miks is back: a stop its quit left pending is off.
    socket.send(JSON.stringify({ type: "stopWhenIdle", value: false }));
    openPendingFolders();
  }
}

/**
 * Reconnects a window on this Mac once its daemon is back from a restart.
 * launchd starts the new one (the old one's `kickstart`), so this only waits
 * for it: starting one too would replace the job mid-start. If none answers
 * in 15s, connecting starts one, as usual.
 */
async function awaitRestart(contents: WebContents) {
  contents.send("miks:status", { connected: false, error: "The daemon is restarting…", retrying: true });
  for (let i = 0; i < 75 && !(await daemonGet("/api/ping")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!contents.isDestroyed() && !links.has(contents)) linkWindow(contents);
}

ipcMain.on("miks:send", (event, message: string) => {
  links.get(event.sender)?.send(message);
});

/**
 * A request to a daemon's HTTP API (this Mac's, or a remote's through its
 * link's socket): its JSON, or null if it isn't answering.
 */
function daemonGet(apiPath: string, socketFile = socketPath(), method = "GET"): Promise<any> {
  return new Promise((resolve) => {
    const request = http.request({ socketPath: socketFile, path: apiPath, method, headers: { [API_HEADER]: "1" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.end();
  });
}

/**
 * Restarts the daemon of the window you're in, ending every terminal in it:
 * how new daemon code takes effect. This Mac's is stopped, and every window
 * on it reconnects, which starts a fresh one; a remote's restarts itself
 * (there's no starting one from here), and its window reconnects on its own.
 */
async function restartDaemon(window: BrowserWindow | undefined) {
  const remote = window ? remoteFor(window.webContents) : null;
  let socketFile = socketPath();
  if (remote) {
    try {
      socketFile = await remoteSocket(remote);
    } catch (error) {
      return show(window, { message: `Couldn't reach ${remote.name}`, detail: String(error instanceof Error ? error.message : error) });
    }
  }
  const ping = await daemonGet("/api/ping", socketFile);

  // A restart brings every tab back, in its folder with its history, along
  // with its kept command or Claude session; it always asks (the menu's "…"),
  // naming what won't come back, or would be cut off mid-task.
  const lost = await runningPrograms(socketFile, { restored: true });
  const shown = lost.slice(0, 8);
  const more = lost.length - shown.length;
  const { response } = await show(window, {
    type: lost.length > 0 ? "warning" : "question",
    message: remote ? `Restart ${remote.name}'s daemon?` : "Restart the daemon?",
    detail:
      lost.length > 0
        ? `Every tab comes back, but restarting stops what's running in these${remote ? ` on ${remote.name}` : ""}:\n\n` +
          shown.join("\n") +
          (more ? `\nand ${more} more` : "")
        : "Every tab comes back as it was, with its history and Claude session.",
    buttons: ["Restart", "Cancel"],
    defaultId: lost.length > 0 ? 1 : 0,
    cancelId: 1,
  });
  if (response !== 0) return;

  if (remote) {
    const answer = await daemonGet("/api/restart", socketFile, "POST");
    if (!answer?.ok) {
      show(window, {
        message: `${remote.name}'s daemon can't restart from here`,
        detail: "It's from an older Miks. Update Miks there, and restart its daemon there once.",
      });
    }
    return;
  }

  if (ping?.pid) {
    process.kill(ping.pid, "SIGTERM");
    // Wait for it to let go of the socket, so we don't reconnect to it.
    for (let i = 0; i < 50 && (await daemonGet("/api/ping")); i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  for (const [contents, remote] of windowRemotes) if (!remote) linkWindow(contents);
}

/**
 * MIKS_BACKGROUND=1 (for agents testing a scratch Miks): no Dock icon, and
 * windows that never take focus from whatever you're doing.
 */
const BACKGROUND = !!process.env.MIKS_BACKGROUND;
if (BACKGROUND) app.setActivationPolicy("accessory");

function bringForward(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  if (BACKGROUND) return window.showInactive();
  window.show();
  app.focus({ steal: true });
}

function show(window: BrowserWindow | undefined, options: Electron.MessageBoxOptions) {
  return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

//
// The window.
//

/** One window per daemon: "local", or a remote's id. */
const windows = new Map<string, BrowserWindow>();
const LOCAL = "local";

/** Brings forward the window on that daemon, opening it if there's none. */
function openWindow(remoteId: string | null = null): BrowserWindow {
  const window = windows.get(remoteId ?? LOCAL);
  if (!window) return createWindow(remoteId);
  bringForward(window);
  return window;
}

function createWindow(remoteId: string | null = null) {
  const key = remoteId ?? LOCAL;
  const remote = remoteId ? settings.remotes.find((r) => r.id === remoteId) : null;
  const saved = loadWindowState(key);
  const window = new BrowserWindow({
    // In the background, shown without being made active once it's ready.
    show: !BACKGROUND,
    width: 1280,
    height: 800,
    ...saved?.bounds,
    minWidth: 500,
    minHeight: 300,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: windowBackground(),
    // For the Window menu and Mission Control; the page has its own titlebar.
    title: remote ? `Miks — ${remote.name}` : "Miks",
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      // The panel's browser (`miks browse`; browse.ts).
      webviewTag: true,
    },
  });

  const contents = window.webContents;
  windowRemotes.set(contents, remoteId);
  contents.on("destroyed", () => {
    links.get(contents)?.close();
    links.delete(contents);
    clearTimeout(retries.get(contents));
    windowRemotes.delete(contents);
  });
  // The page would title the window after itself.
  window.on("page-title-updated", (event) => event.preventDefault());

  // What went wrong in the page, kept: its console's errors (uncaught ones
  // and what ErrorBoundary catches go there too) and its renderer going. A
  // window once went white with nothing anywhere to say why.
  contents.on("console-message", (event) => {
    if (event.level === "error") logRenderer(key, `${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  contents.on("render-process-gone", (_event, details) => logRenderer(key, `Renderer gone: ${details.reason}, exit ${details.exitCode}`));
  contents.on("unresponsive", () => logRenderer(key, "Unresponsive."));

  // ⌃⌘← and ⌃⌘→ go through workspaces too, a second way to the menu's
  // ⌃⌘[ and ⌃⌘] (a menu item takes one shortcut).
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !input.meta || !input.control || input.shift || input.alt) return;
    const name = input.key === "ArrowRight" ? "nextWorkspace" : input.key === "ArrowLeft" ? "previousWorkspace" : null;
    if (!name) return;
    event.preventDefault();
    contents.send("miks:command", name);
  });

  // Nothing navigates the window away from the UI (a stray file drop would).
  contents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== new URL(contents.getURL()).origin) event.preventDefault();
  });

  // Links clicked in a terminal or the chat panel open in the real browser.
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: "deny" };
  });

  // The panel's browser shows any page at all, so it gets nothing of
  // Miks's: no preload (`window.miks` types into your shells), no Node, and
  // only the session that goes through this window's daemon.
  contents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    if (!isBrowsePartition(key, params.partition)) event.preventDefault();
  });
  // A page's new windows (target="_blank" links) open in the real browser,
  // like a terminal's links: a window of Miks's own would be outside the
  // panel, and its proxy. The webview has `allowpopups`, without which
  // they never get here and the click does nothing.
  contents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^(https?|mailto):/i.test(url)) openLink(url);
      return { action: "deny" };
    });
  });

  const devUrl = process.env.MIKS_UI_URL;
  if (devUrl) window.loadURL(devUrl);
  else window.loadFile(path.join(root, "packages/ui/dist/index.html"));

  if (BACKGROUND) window.once("ready-to-show", () => window.showInactive());
  if (saved?.maximized) window.maximize();
  rememberWindowState(window, key);

  windows.set(key, window);
  // Not while quitting, when windows closing hand focus to the others.
  window.on("focus", () => {
    if (!quitting) fs.writeFileSync(frontWindowPath(), JSON.stringify(key));
  });
  // Not for this Mac's, which opens first, before the list is read.
  if (remoteId) rememberOpenRemotes();
  if (remoteId) confirmRemoteClose(window);
  window.on("closed", () => {
    if (windows.get(key) === window) windows.delete(key);
    // Closed by hand, it stays closed; open when Miks quit, it comes back.
    if (!quitting) rememberOpenRemotes();
    if (remoteId && !windows.has(key)) stopRemote(remoteId);
  });
  return window;
}

/**
 * A remote's Miks that quit while this window had its daemon left it to stop
 * when the last window goes: closing this one, then, ends its terminals, so
 * it asks first if programs are running in them.
 */
function confirmRemoteClose(window: BrowserWindow) {
  let checked = false;
  window.on("close", (event) => {
    const remote = remoteFor(window.webContents);
    const link = links.get(window.webContents);
    if (checked || !remote || !link) return;
    event.preventDefault();

    (async () => {
      const socketFile = await remoteSocket(remote).catch(() => null);
      const ping = socketFile ? await daemonGet("/api/ping", socketFile) : null;
      let close = true;
      if (socketFile && ping?.stopWhenIdle && (ping.clients ?? 0) <= 1) {
        // Its Miks brings every tab back when it next opens.
        const running = await runningPrograms(socketFile, { restored: true });
        if (running.length > 0) {
          const { response } = await show(window, {
            type: "warning",
            message: "Close this window?",
            detail: `Miks on ${remote.name} has quit, so closing its last window stops what's running in these (the tabs come back when it opens again):\n\n${running.slice(0, 8).join("\n")}`,
            buttons: ["Close", "Cancel"],
            defaultId: 0,
            cancelId: 1,
          });
          close = response === 0;
        }
      }
      if (!close) {
        quitting = false;
        return;
      }
      checked = true;
      window.close();
    })();
  });
}

//
// Remote windows open when Miks last quit open again with it.
//

const openRemotesPath = () => path.join(app.getPath("userData"), "remote-windows.json");

/** Appends to UI/renderer.log, which starts over (keeping the last as .old) past 1 MB. */
function logRenderer(key: string, message: string) {
  const file = path.join(app.getPath("userData"), "renderer.log");
  try {
    if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 1 << 20) fs.renameSync(file, `${file}.old`);
    fs.appendFileSync(file, `${new Date().toISOString()} [${key}] ${message}\n`);
  } catch {}
}

function rememberOpenRemotes() {
  const ids = [...windows.keys()].filter((key) => key !== LOCAL);
  fs.writeFileSync(openRemotesPath(), JSON.stringify(ids));
}

function reopenRemotes() {
  try {
    const ids: string[] = JSON.parse(fs.readFileSync(openRemotesPath(), "utf8"));
    for (const id of ids) if (settings.remotes.some((remote) => remote.id === id)) openWindow(id);
  } catch {}
}

/** Which window was in front, so that's the one in front again after a relaunch. */
const frontWindowPath = () => path.join(app.getPath("userData"), "front-window.json");

function restoreFrontWindow() {
  try {
    const window = windows.get(JSON.parse(fs.readFileSync(frontWindowPath(), "utf8")));
    if (!window) return;
    // In the background, in front of the others without taking focus.
    if (BACKGROUND) window.moveTop();
    else window.focus();
  } catch {}
}

/** What a window's page shows of the machine it's on: null for this Mac. */
const targetFor = (contents: WebContents) => {
  const remote = remoteFor(contents);
  return remote ? { name: remote.name, color: remote.color, host: remote.host } : null;
};

/** This Mac as Sharing settings names it, as the daemon says its own (server/Version.ts). */
let machineName: string | null = null;

ipcMain.on("miks:client", (event) => {
  if (!machineName) {
    const name = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).stdout?.trim();
    machineName = name || os.hostname().replace(/\.local$/, "");
  }
  event.returnValue = { kind: "mac", machine: machineName };
});

ipcMain.on("miks:getTarget", (event) => {
  event.returnValue = targetFor(event.sender);
});

ipcMain.handle("miks:tailnetMacs", async () => {
  try {
    return { macs: await tailnetMacs() };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.on("miks:openRemote", (_event, id: string) => {
  if (settings.remotes.some((remote) => remote.id === id)) openWindow(id);
});

//
// Where the window was, in the UI's profile folder, so it reopens there.
//

type WindowState = { bounds: Electron.Rectangle; maximized: boolean };

// Each daemon's window has its own: window.json for this Mac's.
const windowStatePath = (key: string) =>
  path.join(app.getPath("userData"), key === LOCAL ? "window.json" : `window-${key}.json`);

function loadWindowState(key: string): WindowState | null {
  try {
    const state: WindowState = JSON.parse(fs.readFileSync(windowStatePath(key), "utf8"));
    // Somewhere you can still see: not on a display that's since gone away.
    const { bounds } = state;
    const visible = screen.getAllDisplays().some(({ workArea: area }) =>
      bounds.x < area.x + area.width &&
      bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height &&
      bounds.y + bounds.height > area.y,
    );
    return visible ? state : null;
  } catch {
    return null;
  }
}

function rememberWindowState(window: BrowserWindow, key: string) {
  let timer: NodeJS.Timeout | null = null;

  const save = () => {
    if (window.isDestroyed() || window.isFullScreen()) return;
    // The size it returns to when un-maximized, not the maximized size.
    const state: WindowState = { bounds: window.getNormalBounds(), maximized: window.isMaximized() };
    fs.writeFileSync(windowStatePath(key), JSON.stringify(state));
  };
  const saveSoon = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };

  window.on("resize", saveSoon);
  window.on("move", saveSoon);
  window.on("maximize", saveSoon);
  window.on("unmaximize", saveSoon);
  window.on("close", () => {
    if (timer) clearTimeout(timer);
    save();
  });
}

/**
 * What the window shows before the page paints: the UI's own background for
 * the current appearance, so a launch doesn't flash the wrong one.
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#1a1b1e" : "#ffffff";
}

nativeTheme.on("updated", () => {
  for (const window of BrowserWindow.getAllWindows()) window.setBackgroundColor(windowBackground());
});

/**
 * Opens a link in the browser chosen in Settings, or the default one (also
 * for anything not on the web, and if that browser won't open).
 */
function openLink(url: string) {
  const { browser } = settings;
  if (!browser || !/^https?:/i.test(url)) return void shell.openExternal(url);
  const child = spawn("open", [browser.startsWith("/") ? "-a" : "-b", browser, url], { stdio: "ignore" });
  child.on("error", () => shell.openExternal(url));
  child.on("exit", (code) => code !== 0 && shell.openExternal(url));
}

// Settings' "Choose app…" for links: resolves with its path, or null.
ipcMain.handle("miks:chooseBrowser", async (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: "Open links in",
    buttonLabel: "Choose",
    defaultPath: "/Applications",
    filters: [{ name: "Applications", extensions: ["app"] }],
    properties: ["openFile" as const],
  };
  const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return canceled ? null : (filePaths[0] ?? null);
});

// The page asks before doing something it can't undo (closing a tab with a
// program running in it): a native sheet, like the quit warning.
ipcMain.handle("miks:confirm", async (event, { message, detail, button }: { message: string; detail: string; button: string }) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = { type: "warning" as const, message, detail, buttons: [button, "Cancel"], defaultId: 0, cancelId: 1 };
  const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
  return response === 0;
});

// Dropped files, copied by the daemon: into a temporary folder for a window
// on another Mac, which can't use this one's paths (a local window types
// them as they are), or into the tab's folder (⌥). Each is a tar stream to
// the daemon (through its gateway, for a remote), so size and folders are no
// trouble. Resolves with where each landed.
ipcMain.handle("miks:sendFiles", async (event, tabId: string, paths: string[], into: "tmp" | "cwd") => {
  const remote = remoteFor(event.sender);
  if (!remote && into === "tmp") return paths;
  const socketFile = remote ? await remoteSocket(remote).catch(() => null) : socketPath();
  if (!socketFile) return [];

  const saved: string[] = [];
  for (const file of paths) {
    const where = await sendFile(file, `/api/drop?pane=${encodeURIComponent(tabId)}&into=${into}`, socketFile);
    if (where) saved.push(where);
  }
  return saved;
});

// The session for a window's browser, through its daemon (browse.ts).
ipcMain.handle("miks:browsePartition", async (event) => {
  const remoteId = windowRemotes.get(event.sender);
  // By its id, not this window: the front outlives the window that started it.
  return browsePartition(remoteId ?? LOCAL, async () => {
    if (!remoteId) return socketPath();
    const remote = settings.remotes.find((entry) => entry.id === remoteId);
    if (!remote) throw new Error("This machine was removed in Settings.");
    return remoteSocket(remote);
  });
});

/**
 * ⌃V, Claude Code's paste of an image, as a window can do it. Claude reads
 * the clipboard of the Mac it runs on, so in a window on another Mac the
 * image (this Mac's) goes over as a dropped one does, into a temporary
 * folder there, and the window types its path. Says whether there's an
 * image at all, either way.
 */
ipcMain.handle("miks:sendClipboardImage", async (event, tabId: string) => {
  const item = (await clipboard.read()).find((entry) => entry.types.some((type) => type.startsWith("image/")));
  const type = item?.types.find((entry) => entry.startsWith("image/"));
  if (!item || !type) return { image: false };
  const remote = remoteFor(event.sender);
  if (!remote) return { image: true };

  const socketFile = await remoteSocket(remote).catch(() => null);
  if (!socketFile) return { image: true };
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "miks-paste-"));
  try {
    const file = path.join(folder, `pasted-image.${type.slice("image/".length).replace("jpeg", "jpg")}`);
    const blob = (await item.getType(type)) as Blob;
    fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
    const where = await sendFile(file, `/api/drop?pane=${encodeURIComponent(tabId)}&into=tmp`, socketFile);
    return { image: true, path: where ?? undefined };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/** Streams a tar of `file` to a daemon; resolves with where it was saved, or null. */
function sendFile(file: string, apiPath: string, socketFile: string): Promise<string | null> {
  return new Promise((resolve) => {
    // COPYFILE_DISABLE: no AppleDouble "._" files for the extended attributes.
    const tar = spawn("tar", ["-cf", "-", "-C", path.dirname(file), path.basename(file)], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const request = http.request({ socketPath: socketFile, path: apiPath, method: "POST", headers: { [API_HEADER]: "1" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body).path ?? null);
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => {
      tar.kill();
      resolve(null);
    });
    tar.stdout.pipe(request);
  });
}

ipcMain.on("miks:copy", (_event, text: string) => {
  if (typeof text === "string") clipboard.writeText(text);
});

// A notification was clicked: bring its window forward.
ipcMain.on("miks:focus", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  bringForward(window);
});

//
// Settings, in settings.json, shared by every window.
//

const settingsPath = settingsFile();
let settings: Settings = loadSettings();

function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath, "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

ipcMain.on("miks:getSettings", (event) => {
  event.returnValue = settings;
});

ipcMain.on("miks:setSettings", (_event, changes: Partial<Settings>) => {
  const previous = settings.remotes;
  settings = { ...settings, ...changes };
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send("miks:settings", settings);
  if ("claudeHooks" in changes) updateClaudeHooks();
  if ("remotes" in changes) remotesChanged(previous);
});

/**
 * A remote was added, edited or removed: the menu lists them, and windows on
 * one that changed reconnect (somewhere else, if its host changed).
 */
function remotesChanged(previous: Remote[]) {
  buildMenu();
  for (const [contents, id] of windowRemotes) {
    if (!id) continue;
    const before = previous.find((remote) => remote.id === id);
    const now = settings.remotes.find((remote) => remote.id === id);
    if (!contents.isDestroyed()) contents.send("miks:target", targetFor(contents));
    if (now && before?.host === now.host) continue;
    stopRemote(id);
    if (now) linkWindow(contents);
    else BrowserWindow.fromWebContents(contents)?.close();
  }
}

function updateClaudeHooks() {
  // A scratch Miks (MIKS_HOME) mustn't rewire the real Claude Code's hooks.
  if (process.env.MIKS_HOME) return;
  try {
    syncClaudeHooks({
      enabled: settings.claudeHooks,
      bundledScript: path.join(root, "packages/daemon/hooks/claude-hook.sh"),
      installedScript: path.join(miksHome(), "claude-hook.sh"),
      claudeSettingsPath: path.join(os.homedir(), ".claude/settings.json"),
    });
  } catch (error) {
    console.error("Couldn't update Claude Code's hooks:", error);
  }
}

//
// Opening a folder in Miks (`open -a Miks <folder>`, which is what GitHub
// Desktop's custom shell does, or a folder dropped on the Dock icon) selects
// the workspace already there, or makes one.
//

const pendingFolders: string[] = [];

app.on("open-file", (event, file) => {
  event.preventDefault();
  openFolder(file);
});

// miks://update?status=<file>, from `miks update` in a terminal (Miks's zsh),
// opened on whichever Mac that terminal is on.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const parsed = new URL(url);
  const status = parsed.searchParams.get("status");
  if (parsed.host === "update" && status) app.whenReady().then(() => updateFromShell(status));
});

// Or given as arguments, launching Miks.app's binary directly.
if (app.isPackaged) for (const arg of process.argv.slice(1)) if (!arg.startsWith("-")) openFolder(arg);

function openFolder(file: string) {
  let folder: string;
  try {
    folder = fs.statSync(file).isDirectory() ? file : path.dirname(file);
  } catch {
    return;
  }
  pendingFolders.push(path.resolve(folder));
  if (app.isReady()) openPendingFolders();
}

async function openPendingFolders() {
  if (pendingFolders.length === 0) return;
  // Folders are this Mac's, so always its window.
  const window = app.isReady() ? openWindow() : null;
  // Once connected; linkWindow calls back.
  const link = window && links.get(window.webContents);
  if (!window || !link) return;

  const folders = pendingFolders.splice(0);
  const state = await daemonGet("/api/state");
  for (const folder of folders) {
    const existing = (state?.workspaces ?? []).find(
      (w: any) => w.cwd === folder || w.tabs.some((tab: any) => tab.cwd === folder),
    );
    link.send(
      JSON.stringify(existing ? { type: "select", workspaceId: existing.id } : { type: "createWorkspace", cwd: folder }),
    );
  }

  bringForward(window);
}


//
// The menu. Accelerators reach us before the terminal sees the keystroke,
// which is how ⌘T and friends work while a terminal has focus.
//

function command(name: string, accelerator: string, label: string): MenuItemConstructorOptions {
  return {
    label,
    accelerator,
    click: (_item, window) => (window as BrowserWindow | undefined)?.webContents.send("miks:command", name),
  };
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    {
      role: "appMenu",
      submenu: [
        {
          // What `miks version` says, for the window's daemon; Electron's own panel with no window.
          label: "About Miks",
          click: (_item, window) =>
            window ? (window as BrowserWindow).webContents.send("miks:command", "versions") : app.showAboutPanel(),
        },
        { type: "separator" },
        { label: "Check for updates…", click: () => checkForUpdates() },
        { type: "separator" },
        command("settings", "CmdOrCtrl+,", "Settings…"),
        { type: "separator" },
        {
          // This Mac's: another Mac's daemon is its own business.
          label: "Restart daemon…",
          click: (_item, window) => restartDaemon(window as BrowserWindow | undefined),
        },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        command("newTab", "CmdOrCtrl+T", "New tab"),
        command("newWorkspace", "CmdOrCtrl+N", "New workspace"),
        { type: "separator" },
        command("closeTab", "CmdOrCtrl+W", "Close tab"),
        // Not ⌘⇧W, which closes the window, as everywhere else on a Mac.
        command("closeWorkspace", "CmdOrCtrl+Alt+W", "Close workspace"),
        { role: "close", label: "Close window", accelerator: "CmdOrCtrl+Shift+W" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        // For pasting a command and what it printed into an agent elsewhere.
        command("selectLastCommand", "CmdOrCtrl+Shift+A", "Select last command"),
        command("clearToStart", "CmdOrCtrl+K", "Clear to start"),
      ],
    },
    {
      label: "View",
      submenu: [
        command("toggleSidebar", "CmdOrCtrl+B", "Toggle sidebar"),
        command("toggleChat", "CmdOrCtrl+Shift+C", "Toggle panel"),
        command("toggleExpanded", "CmdOrCtrl+Shift+F", "Panel fills the tab"),
        { type: "separator" },
        command("fontBigger", "CmdOrCtrl+=", "Bigger text"),
        command("fontSmaller", "CmdOrCtrl+-", "Smaller text"),
        command("fontReset", "CmdOrCtrl+0", "Actual size"),
        { type: "separator" },
        // Reloading the UI is free: the terminals live in the daemon.
        { role: "reload", label: "Reload UI" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      // A window on each Mac's terminals, one keystroke away: ⌃⌥⌘ with a
      // digit, which next to nothing else uses.
      label: "Remotes",
      submenu: [
        { label: "This Mac", accelerator: "Ctrl+Alt+Cmd+0", click: () => openWindow() },
        { type: "separator" },
        ...settings.remotes
          .filter((remote) => remote.name && remote.host)
          .map((remote, i): MenuItemConstructorOptions => ({
            label: remote.name,
            accelerator: i < 9 ? `Ctrl+Alt+Cmd+${i + 1}` : undefined,
            click: () => openWindow(remote.id),
          })),
        { type: "separator" },
        {
          label: "Add a Mac…",
          click: (_item, window) =>
            ((window as BrowserWindow | undefined) ?? openWindow()).webContents.send("miks:command", "settingsRemotes"),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        command("nextTab", "CmdOrCtrl+Shift+]", "Next tab"),
        command("previousTab", "CmdOrCtrl+Shift+[", "Previous tab"),
        // As in cmux. ⌃⌘← and ⌃⌘→ work too (see createWindow).
        command("nextWorkspace", "Cmd+Ctrl+]", "Next workspace"),
        command("previousWorkspace", "Cmd+Ctrl+[", "Previous workspace"),
        { type: "separator" },
        ...Array.from({ length: 9 }, (_, i) => command(`workspace${i + 1}`, `CmdOrCtrl+${i + 1}`, `Workspace ${i + 1}`)),
        { type: "separator" },
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.setName("Miks");

// Electron keeps its browser profile under the app's name by default, which
// is the daemon's own folder; give it a room of its own there.
app.setPath("userData", path.join(miksHome(), "UI"));

app.whenReady().then(() => {
  // Miks.app has its icon in its bundle; the dev build is plain Electron.
  if (!app.isPackaged) app.dock?.setIcon(iconPath);
  buildMenu();
  createWindow();
  reopenRemotes();
  restoreFrontWindow();
  updateClaudeHooks();
  startUpdates(confirmQuitForUpdate);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => stopAllRemotes());

// Closing the last window quits, like a terminal app.
app.on("window-all-closed", () => app.quit());

//
// Quitting. Like any terminal app, quitting ends the terminals (it stops the
// daemon), asking first about programs running in them that the next launch
// won't bring back, or would cut off mid-task. Except: with
// "Keep terminals running" on; when another window still uses the daemon (the
// dev build beside Miks.app); and when install-app relaunches us (SIGUSR2).
// The daemon saves its layout as it stops, so the next launch brings it back
// and resumes the Claude sessions in it.
//

let quitChecked = false;
let relaunching = false;
/** Windows closing now are closing because Miks is quitting. */
let quitting = false;

process.on("SIGUSR2", () => {
  relaunching = true;
  app.quit();
});

app.on("before-quit", (event) => {
  quitting = true;
  if (quitChecked || relaunching || settings.keepDaemonRunning) return;
  event.preventDefault();
  stopDaemonForQuit().then((quit) => {
    if (!quit) {
      quitting = false;
      return;
    }
    quitChecked = true;
    app.quit();
  });
});

/** Restarting to install an update is a quit like any other. */
async function confirmQuitForUpdate(): Promise<boolean> {
  if (!relaunching && !settings.keepDaemonRunning && !(await stopDaemonForQuit())) return false;
  quitChecked = true;
  return true;
}

/** Stops the daemon, unless that means stopping programs you'd rather keep. */
async function stopDaemonForQuit(): Promise<boolean> {
  // Only ever this Mac's daemon, and only its windows count.
  const localLinks = [...links].filter(([contents]) => !windowRemotes.get(contents));
  const ping = await daemonGet("/api/ping");
  if (!ping?.pid) return true;
  if ((ping.clients ?? 0) > localLinks.length) {
    // A window on another Mac still has it: it stops when that one goes.
    const socket = localLinks[0]?.[1];
    if (socket) {
      await new Promise((resolve) => socket.send(JSON.stringify({ type: "stopWhenIdle", value: true }), resolve));
    }
    return true;
  }

  // The next launch brings every tab back, with its kept command or Claude
  // session; only what that won't restore, or would cut short, is worth asking.
  const running = await runningPrograms(socketPath(), { restored: true });
  if (running.length > 0) {
    const shown = running.slice(0, 8);
    const more = running.length - shown.length;
    const options = {
      type: "warning" as const,
      message: "Quit Miks?",
      detail:
        `Every tab comes back next time, but quitting stops what's running in these:\n\n${shown.join("\n")}` +
        (more ? `\nand ${more} more` : "") +
        `\n\nTo keep terminals running after Miks quits, turn on "Keep terminals running" in Settings.`,
      buttons: ["Quit", "Cancel"],
      defaultId: 0,
      cancelId: 1,
    };
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
    if (response !== 0) return false;
  }

  // Let go of it first, so no window reconnects (and restarts it) as it goes.
  for (const [contents, socket] of localLinks) {
    socket.close();
    links.delete(contents);
  }
  process.kill(ping.pid, "SIGTERM");
  return true;
}

/** "claude in sage", one per program in front of a shell. */
/** This Mac's, which its daemon keeps for every window (machine.json); settings.json's before that. */
function hidePathPrefix(): string {
  try {
    const prefix = JSON.parse(fs.readFileSync(path.join(miksHome(), "machine.json"), "utf8")).hidePathPrefix;
    if (typeof prefix === "string") return prefix;
  } catch {}
  return settings.hidePathPrefix;
}

/** What's running, a line each; with `restored`, only what a restart would lose (describeRunning). */
async function runningPrograms(socketFile = socketPath(), { restored = false } = {}): Promise<string[]> {
  const result = await daemonGet("/api/running", socketFile);
  if (Array.isArray(result?.running)) {
    return describeRunning(result.running as RunningProgram[], { restored, prefix: hidePathPrefix(), home: app.getPath("home") });
  }

  // A daemon from before /api/running: all we can say is how many terminals.
  const state = await daemonGet("/api/state", socketFile);
  const tabs = (state?.workspaces ?? []).reduce((count: number, w: any) => count + w.tabs.length, 0);
  return tabs ? [`${tabs} terminal${tabs === 1 ? "" : "s"}`] : [];
}
