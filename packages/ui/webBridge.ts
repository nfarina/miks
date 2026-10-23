// Miks on another of your devices (an iPad, a phone), through a Mac daemon's
// gateway for Tailscale (packages/daemon/server/Gateway.ts): `window.miks`,
// which Electron's preload gives Miks's own windows, as a WebSocket the
// gateway pipes to the daemon. A page the gateway served (a browser) connects
// back to it; the iOS app's (crosswing://app, or the bundle's own site), to
// whichever of the Macs you've added it shows, watching the others for what
// their agents are doing. Imported first, before anything reads `window.miks`.
import type { AgentStatus, DaemonMessage } from "miks/shared/protocol";
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import type { BridgeStatus, Mac, MiksBridge } from "./daemon";

/** This device's own settings (the sidebar, the text size), kept in the browser, not the Mac's. */
const SETTINGS_KEY = "miks-settings";

/** The Mac this device's app shows, by its full Tailscale name and port. */
const MAC_KEY = "miks-mac";

/** Every Mac it's been connected to, the same way. */
const MACS_KEY = "miks-macs";

/** Most urgent first, as the sidebar ranks a workspace's tabs. */
const URGENCY: AgentStatus[] = ["waiting", "done", "working", "idle"];

/** Where a Mac's gateway listens. */
const GATEWAY_PORT = 2741;

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

/** Whether the iOS app says a hardware keyboard is connected, so focusing brings up no on-screen one. */
export const hardwareKeyboard = () => keyboardConnected;

let keyboardConnected = false;
(window as any).miks_hardwareKeyboard = (connected: boolean) => (keyboardConnected = connected);
void askApp<{ connected?: boolean }>("hardwareKeyboard").then((result) => {
  if (result) keyboardConnected = !!result.connected;
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
class Watcher {
  status: AgentStatus | null = null;
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
    socket.onopen = () => socket.send(JSON.stringify({ type: "hello" }));
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as DaemonMessage;
      if (message.type !== "state") return;
      const statuses = message.state.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => tab.agent?.status));
      this.status = URGENCY.find((status) => statuses.includes(status)) ?? null;
      this.connected = true;
      this.onChange();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connected = false;
      this.onChange();
      if (!this.closed) this.retry = setTimeout(() => this.connect(), RETRY_DELAY * 5);
    };
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

function webBridge(): MiksBridge {
  const messageListeners = new Set<(message: string) => void>();
  const statusListeners = new Set<(status: BridgeStatus) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();
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
      macsChanged();
      status({ connected: true });
    };
    next.onmessage = (event) => messageListeners.forEach((listener) => listener(String(event.data)));
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      connected = false;
      macsChanged();
      status({ connected: false, retrying: true, error: `Reconnecting to Miks on ${name}…` });
      retry = setTimeout(connect, RETRY_DELAY);
    };
  }

  // A phone puts a page to sleep; on coming back, don't wait out the retry.
  document.addEventListener("visibilitychange", () => {
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
    onCommand: () => () => {},
    pathForFile: () => "",
    sendFiles: async () => [],
    sendClipboardImage: async () => ({ image: false }),
    browsePartition: () => Promise.reject(new Error("Pages open only in Miks on a Mac, for now.")),
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
