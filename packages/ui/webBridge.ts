// Miks on another of your devices (an iPad, a phone), through a Mac daemon's
// gateway for Tailscale (packages/daemon/server/Gateway.ts): `window.miks`,
// which Electron's preload gives Miks's own windows, as a WebSocket the
// gateway pipes to the daemon. A page the gateway served (a browser) connects
// back to it; the iOS app's (crosswing://app, or the bundle's own site), to
// whichever of the Macs you've added it shows, watching the others for what
// their agents are doing. Imported first, before anything reads `window.miks`.
import type { AgentStatus, ClientInfo, ClientMessage, DaemonMessage } from "miks/shared/protocol";
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import type { BridgeStatus, Mac, MacWorkspace, MiksBridge, PageState } from "./daemon";
import { deviceName, UI_BUILD } from "./client";
import { workspaceStatus, workspaceTitle } from "./status";

/** This device's own settings (the sidebar, the text size), kept in the browser, not the Mac's. */
const SETTINGS_KEY = "miks-settings";

/** The Mac this device's app shows, by its full Tailscale name and port. */
const MAC_KEY = "miks-mac";

/** Every Mac it's been connected to, the same way. */
const MACS_KEY = "miks-macs";

/** When each was last connected, by host, for the chooser's "seen 3 hours ago". */
const SEEN_KEY = "miks-macs-seen";

/** Most urgent first, as the sidebar ranks a workspace's tabs. */
const URGENCY: AgentStatus[] = ["waiting", "done", "working", "idle"];

/** Where a Mac's gateway listens. */
const GATEWAY_PORT = 2741;

/** This install's own id, for each Mac's list of devices to push to (server/Push.ts). */
const DEVICE_KEY = "miks-device";

/** The relay's id for this device's push token, and the token it's for. */
const PUSH_KEY = "miks-push";

/** Holds the APNs key, and turns a device's token into an id (push/worker.js). */
const PUSH_RELAY = "https://miks-push.nfarina.com";

/** How long a dropped connection waits before trying again. */
const RETRY_DELAY = 2000;

/** The gateway marks the page it serves. */
const fromGateway = !!document.querySelector('meta[name="miks-gateway"]');

/**
 * Where a Mac's gateway is, from what Settings there shows
 * ("https://air.tailbf8edc.ts.net:2741/") or just its name: host and port.
 */
export function gatewayHost(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`);
    return `${url.hostname}:${url.port || GATEWAY_PORT}`;
  } catch {
    return null;
  }
}

/** What a Mac is called in the switcher: its short name. */
export function macName(host: string): string {
  return host.split(".")[0].split(":")[0];
}

/**
 * The full name for a short one ("air"), which is all a Mac's certificate is
 * for: the iOS app looks it up (MiksPlugin.swift). Null where it can't.
 */
async function fullHost(host: string): Promise<string | null> {
  const [name, port] = host.split(":");
  if (name.includes(".") || /^[\d.]+$|:/.test(name)) return host;
  const result = await askApp<{ name?: string }>("fullName", { host: name });
  return result?.name ? `${result.name}:${port}` : null;
}

/**
 * Asks the iOS app's plugin (MiksPlugin.swift), which answers by calling the
 * function named. Null outside the app, or from an app too old to answer.
 */
async function askApp<T>(name: string, args: object = {}): Promise<T | null> {
  const app = (window as any).webkit?.messageHandlers?.default;
  if (!app) return null;
  const callback = `miksAnswer${++callbacks}`;
  const result = await new Promise<T | null>((resolve) => {
    (window as any)[callback] = resolve;
    setTimeout(() => resolve(null), 5000);
    app.postMessage({ plugin: "miks", name, ...args, callback: `window.${callback}` });
  });
  delete (window as any)[callback];
  return result;
}

let callbacks = 0;

/** Tells the iOS app's plugin something, wanting no answer. */
function tellApp(name: string, args: object = {}) {
  (window as any).webkit?.messageHandlers?.default?.postMessage({ plugin: "miks", name, ...args });
}

/** Whether the iOS app says a hardware keyboard is connected, so focusing brings up no on-screen one. */
export const hardwareKeyboard = () => keyboardConnected;

let keyboardConnected = false;
(window as any).miks_hardwareKeyboard = (connected: boolean) => (keyboardConnected = connected);
void askApp<{ connected?: boolean }>("hardwareKeyboard").then((result) => {
  if (result) keyboardConnected = !!result.connected;
});

/** The iOS app's own version, and the device's name (MiksPlugin.swift); null from an app before it said. */
type AppInfo = { version: string; build: string; device: string };
let appInfo: AppInfo | null = null;
void askApp<AppInfo>("appInfo").then((info) => (appInfo = info?.version ? info : null));

/** What this page is and where, for `miks version` (`ClientInfo`). */
const client = (): Omit<ClientInfo, "ui"> => ({
  kind: inApp ? "ios" : "browser",
  machine: appInfo?.device ?? deviceName(),
  ...(appInfo && { app: { version: appInfo.version, build: appInfo.build } }),
});

function readStorage<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text === null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

function writeStorage(key: string, value: unknown) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

/**
 * A Mac in the background: connected, with nothing attached, for what its
 * agents are doing, so the switcher can say one needs you.
 */
//
// Push notifications, in the iOS app: it hands over its device token, the
// relay seals it into an id, and every Mac gets that (`device`), with
// whether this device is showing it right now, which it never pushes to.
//

const inApp = !fromGateway && !!(window as any).webkit?.messageHandlers?.default;

const deviceId: string = (() => {
  let id = readStorage<string | null>(DEVICE_KEY, null);
  if (!id) writeStorage(DEVICE_KEY, (id = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`));
  return id;
})();

let pushId = readStorage<{ token: string; id: string } | null>(PUSH_KEY, null)?.id ?? null;
const pushListeners = new Set<() => void>();

/** What a socket to the Mac at `host` tells it about this device. */
function deviceMessage(host: string, visible: boolean): string | null {
  if (!inApp) return null;
  // An iPad says it's a Mac; one with a touch screen isn't.
  const ua = navigator.userAgent;
  const name = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? "iPad" : "iPhone";
  return JSON.stringify({
    type: "device",
    deviceId,
    device: pushId && { id: pushId, deviceId, name, host },
    visible,
  });
}

/** The app's token (from the start, or once it has one), registered with the relay if it's new. */
async function takePushToken(info: { token?: string; environment?: string } | null) {
  if (!info?.token || !info.environment) return;
  const known = readStorage<{ token: string; id: string } | null>(PUSH_KEY, null);
  if (known?.token === info.token) return;
  try {
    const response = await fetch(`${PUSH_RELAY}/register`, {
      method: "POST",
      body: JSON.stringify({ token: info.token, environment: info.environment }),
    });
    const { id } = await response.json();
    if (typeof id !== "string") return;
    writeStorage(PUSH_KEY, { token: info.token, id });
    pushId = id;
    pushListeners.forEach((listener) => listener());
  } catch (error) {
    console.error("Couldn't register for notifications:", error);
  }
}

if (inApp) {
  (window as any).miks_pushToken = (info: { token?: string; environment?: string }) => void takePushToken(info);
  void askApp<{ token?: string; environment?: string }>("pushToken").then(takePushToken);
}

class Watcher {
  status: AgentStatus | null = null;
  workspaces: MacWorkspace[] = [];
  connected = false;
  private socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly host: string,
    private readonly onChange: () => void,
  ) {
    this.connect();
  }

  connect() {
    if (this.closed || this.socket) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    let socket: WebSocket;
    try {
      socket = new WebSocket(`wss://${this.host}/ws`);
    } catch {
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "hello", client: { ...client(), ui: UI_BUILD, watching: true } } satisfies ClientMessage));
      this.announce();
    };
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as DaemonMessage;
      if (message.type !== "state") return;
      const statuses = message.state.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => tab.agent?.status));
      this.status = URGENCY.find((status) => statuses.includes(status)) ?? null;
      this.workspaces = message.state.workspaces.map((workspace) => ({
        title: workspaceTitle(workspace),
        status: workspaceStatus(workspace),
      }));
      this.connected = true;
      sawMac(this.host);
      this.onChange();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      if (this.connected) sawMac(this.host);
      this.socket = null;
      this.connected = false;
      this.onChange();
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RETRY_DELAY * 5);
    };
  }

  /** Tells the Mac about this device (it isn't showing it: this is a watcher). */
  announce() {
    const message = deviceMessage(this.host, false);
    if (message && this.socket?.readyState === WebSocket.OPEN) this.socket.send(message);
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

let seen = readStorage<Record<string, number>>(SEEN_KEY, {});

/** Notes a Mac as connected just now. */
function sawMac(host: string) {
  writeStorage(SEEN_KEY, (seen = { ...seen, [host]: Date.now() }));
}

function webBridge(): MiksBridge {
  const messageListeners = new Set<(message: string) => void>();
  const statusListeners = new Set<(status: BridgeStatus) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();
  const commandListeners = new Set<(command: string) => void>();
  (window as any).miks_command = (command: string) => commandListeners.forEach((listener) => listener(command));
  const pageListeners = new Set<(state: PageState) => void>();
  (window as any).miks_page = (state: PageState) => pageListeners.forEach((listener) => listener(state));
  // Any left from before a reload are no tab's.
  tellApp("page", { action: "closeAll" });
  const subscribe = <T>(set: Set<T>, listener: T) => (set.add(listener), () => void set.delete(listener));

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const status = (next: BridgeStatus) =>
    statusListeners.forEach((listener) => listener(next));

  // The one on screen, and the rest. Before there was a list, only the one,
  // which may be a short name that never connected ("air").
  let mac: string | null = null;
  try {
    mac = localStorage.getItem(MAC_KEY);
  } catch {}
  let macs = readStorage<string[]>(MACS_KEY, []);
  if (mac && !mac.split(":")[0].includes(".")) mac = null;
  if (mac && !macs.includes(mac)) writeStorage(MACS_KEY, (macs = [...macs, mac]));

  const macListeners = new Set<() => void>();
  const macsChanged = () => macListeners.forEach((listener) => listener());
  const watchers = new Map<string, Watcher>();
  const watchOthers = () => {
    if (fromGateway) return;
    for (const [host, watcher] of watchers) {
      if (host === mac || !macs.includes(host)) {
        watcher.close();
        watchers.delete(host);
      }
    }
    for (const host of macs) if (host !== mac && !watchers.has(host)) watchers.set(host, new Watcher(host, macsChanged));
  };
  let connected = false;

  // Tells the Mac on screen about this device, and that it's showing it (or not, once the app's away).
  const announce = () => {
    const message = mac && deviceMessage(mac, document.visibilityState === "visible");
    if (message && socket?.readyState === WebSocket.OPEN) socket.send(message);
  };
  pushListeners.add(() => {
    announce();
    for (const watcher of watchers.values()) watcher.announce();
  });

  // A tapped notification's tab, opened once its Mac's state says where it is.
  let openingTab: string | null = null;
  const openTab = (state: { workspaces: { id: string; tabs: { id: string }[] }[] }) => {
    const workspace = state.workspaces.find((w) => w.tabs.some((tab) => tab.id === openingTab));
    if (workspace) socket?.send(JSON.stringify({ type: "select", workspaceId: workspace.id, tabId: openingTab }));
    openingTab = null;
  };
  const openNotification = (info: { mac?: string; tabId?: string } | null) => {
    if (!info?.mac || !info.tabId || !macs.includes(info.mac)) return;
    openingTab = info.tabId;
    if (info.mac !== mac) select(info.mac);
    else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "hello" }));
  };
  if (inApp) {
    (window as any).miks_openNotification = openNotification;
    void askApp<{ mac?: string; tabId?: string }>("pendingNotification").then(openNotification);
  }
  let askedForNotifications = false;

  function select(host: string | null) {
    if (host === mac) return connect();
    mac = host;
    try {
      if (host) localStorage.setItem(MAC_KEY, host);
      else localStorage.removeItem(MAC_KEY);
    } catch {}
    watchOthers();
    macsChanged();
    // What was on screen is another Mac's.
    status({ connected: false, reset: true, error: host ? `Connecting to ${macName(host)}…` : undefined });
    connect();
  }

  function connect() {
    if (retry) clearTimeout(retry);
    retry = null;
    const previous = socket;
    socket = null;
    previous?.close();

    // The page's own server, or the Mac you named: always TLS there, since
    // its certificate is the only way an https page (the app's) may connect.
    const url = fromGateway
      ? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`
      : mac && `wss://${mac}/ws`;
    connected = false;
    if (!url) return status({ connected: false, error: "Which Mac?" });
    const name = fromGateway ? location.hostname : macName(mac!);

    // WebKit throws, rather than failing the socket, for an address the page's
    // CSP doesn't allow (a short name like "air"), which took the page down.
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      return status({ connected: false, error: `Couldn't connect to ${name}.` });
    }
    socket = next;
    next.onopen = () => {
      connected = true;
      announce();
      // Once, in the app, with a Mac to hear from: iOS asks only the first time.
      if (inApp && !askedForNotifications) {
        askedForNotifications = true;
        (window as any).webkit.messageHandlers.default.postMessage({ name: "requestNotificationAuthorization" });
      }
      if (mac) sawMac(mac);
      macsChanged();
      status({ connected: true });
    };
    next.onmessage = (event) => {
      const data = String(event.data);
      if (openingTab && data.startsWith('{"type":"state"')) openTab(JSON.parse(data).state);
      messageListeners.forEach((listener) => listener(data));
    };
    next.onclose = () => {
      if (socket !== next) return;
      if (connected && mac) sawMac(mac);
      socket = null;
      connected = false;
      macsChanged();
      status({ connected: false, retrying: true, error: `Reconnecting to Miks on ${name}…` });
      retry = setTimeout(connect, RETRY_DELAY);
    };
  }

  // A phone puts a page to sleep; on coming back, don't wait out the retry.
  document.addEventListener("visibilitychange", () => {
    announce();
    if (document.visibilityState !== "visible") return;
    if (!socket) connect();
    for (const watcher of watchers.values()) watcher.connect();
  });
  watchOthers();

  let local: Partial<Settings> = {};
  try {
    local = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {}
  let settings: Settings = { ...DEFAULT_SETTINGS, ...local };

  return {
    connect,
    // Only where the page isn't a gateway's own: which Macs to connect to.
    macs: fromGateway
      ? undefined
      : {
          list: (): Mac[] =>
            macs.map((host) => ({
              host,
              name: macName(host),
              active: host === mac,
              connected: host === mac ? connected : !!watchers.get(host)?.connected,
              status: host === mac ? null : (watchers.get(host)?.status ?? null),
              workspaces: host === mac ? [] : (watchers.get(host)?.workspaces ?? []),
              seen: seen[host] ?? null,
            })),
          active: () => mac,
          select,
          add: async (input) => {
            const typed = gatewayHost(input);
            if (!typed) return "That isn't an address.";
            const host = await fullHost(typed);
            if (!host) return `Use its full name, with your tailnet's: ${macName(typed)}.something.ts.net.`;
            if (!macs.includes(host)) {
              macs = [...macs, host];
              writeStorage(MACS_KEY, macs);
            }
            select(host);
            return null;
          },
          remove: (host) => {
            macs = macs.filter((other) => other !== host);
            writeStorage(MACS_KEY, macs);
            const { [host]: _, ...rest } = seen;
            writeStorage(SEEN_KEY, (seen = rest));
            if (host === mac) select(null);
            else {
              watchOthers();
              macsChanged();
            }
          },
          onChange: (listener) => subscribe(macListeners, listener),
        },
    send: (message) => {
      if (socket?.readyState === WebSocket.OPEN) socket.send(message);
    },
    onMessage: (listener) => subscribe(messageListeners, listener),
    onStatus: (listener) => subscribe(statusListeners, listener),
    // The iOS app's keyboard shortcuts (AppDelegate.swift), as the Mac app's menu sends them.
    onCommand: (listener) => subscribe(commandListeners, listener),
    pathForFile: () => "",
    sendFiles: async () => [],
    sendClipboardImage: async () => ({ image: false }),
    browsePartition: () => Promise.reject(new Error("Pages open only in Miks, on a Mac or in the iOS app.")),
    // In the app, which loads each through the gateway of the Mac on screen.
    pages:
      !fromGateway && (window as any).webkit?.messageHandlers?.default
        ? {
            tell: (id, action, args = {}) => {
              const [host, port] = (mac ?? "").split(":");
              tellApp("page", { id, action, ...(action === "open" ? { mac: host, port: Number(port) || GATEWAY_PORT } : {}), ...args });
            },
            onState: (listener) => subscribe(pageListeners, listener),
          }
        : undefined,
    getSettings: () => settings,
    setSettings: (changes) => {
      local = { ...local, ...changes };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(local));
      } catch {}
      settings = { ...settings, ...changes };
      settingsListeners.forEach((listener) => listener(settings));
    },
    onSettings: (listener) => subscribe(settingsListeners, listener),
    focus: () => window.focus(),
    getTarget: () => null,
    client,
    onTarget: () => () => {},
    openRemote: () => {},
    // Which app opens links is the Mac's choice; a browser has no apps to pick from.
    chooseBrowser: async () => null,
    confirm: async ({ message, detail }) => window.confirm(`${message}\n\n${detail}`),
    copy: (text) => {
      // The clipboard API needs a secure context; plain http over Tailscale isn't one.
      if (navigator.clipboard && window.isSecureContext) return void navigator.clipboard.writeText(text);
      const area = document.createElement("textarea");
      area.value = text;
      document.body.append(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    },
  };
}

// Last: it needs everything above.
if (!window.miks && (fromGateway || /^(https?|crosswing):$/.test(location.protocol))) window.miks = webBridge();
