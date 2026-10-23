// Miks on another of your devices (an iPad, a phone), through a Mac daemon's
// gateway for Tailscale (packages/daemon/server/Gateway.ts): `window.miks`,
// which Electron's preload gives Miks's own windows, as a WebSocket the
// gateway pipes to the daemon. A page the gateway served (a browser) connects
// back to it; the iOS app's (crosswing://app, or the bundle's own site), to
// the Mac you name, once. Imported first, before anything reads `window.miks`.
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import type { MiksBridge } from "./daemon";

/** This device's own settings (the sidebar, the text size), kept in the browser, not the Mac's. */
const SETTINGS_KEY = "miks-settings";

/** The Mac this device's app connects to, by its full Tailscale name. */
const MAC_KEY = "miks-mac";

/** Where a Mac's gateway listens. */
const GATEWAY_PORT = 2741;

/** How long a dropped connection waits before trying again. */
const RETRY_DELAY = 2000;

/** The gateway marks the page it serves. */
const fromGateway = !!document.querySelector('meta[name="miks-gateway"]');

if (!window.miks && (fromGateway || /^(https?|crosswing):$/.test(location.protocol))) window.miks = webBridge();

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

function webBridge(): MiksBridge {
  const messageListeners = new Set<(message: string) => void>();
  const statusListeners = new Set<(status: { connected: boolean; error?: string; retrying?: boolean }) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();
  const subscribe = <T>(set: Set<T>, listener: T) => (set.add(listener), () => void set.delete(listener));

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const status = (next: { connected: boolean; error?: string; retrying?: boolean }) =>
    statusListeners.forEach((listener) => listener(next));

  let mac: string | null = null;
  try {
    mac = localStorage.getItem(MAC_KEY);
  } catch {}

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
    if (!url) return status({ connected: false, error: "Which Mac?" });
    const name = fromGateway ? location.hostname : mac!.split(":")[0];

    const next = new WebSocket(url);
    socket = next;
    next.onopen = () => status({ connected: true });
    next.onmessage = (event) => messageListeners.forEach((listener) => listener(String(event.data)));
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      status({ connected: false, retrying: true, error: `Reconnecting to Miks on ${name}…` });
      retry = setTimeout(connect, RETRY_DELAY);
    };
  }

  // A phone puts a page to sleep; on coming back, don't wait out the retry.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && !socket) connect();
  });

  let local: Partial<Settings> = {};
  try {
    local = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {}
  let settings: Settings = { ...DEFAULT_SETTINGS, ...local };

  return {
    connect,
    // Only where the page isn't a gateway's own: which Mac to connect to.
    mac: fromGateway
      ? undefined
      : {
          get: () => mac,
          set: (host) => {
            mac = host;
            try {
              if (host) localStorage.setItem(MAC_KEY, host);
              else localStorage.removeItem(MAC_KEY);
            } catch {}
            connect();
          },
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
