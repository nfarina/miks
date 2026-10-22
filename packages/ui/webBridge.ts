// Miks in a browser, on another of your devices (an iPad, a phone) through
// the daemon's gateway for Tailscale (packages/daemon/server/Gateway.ts):
// `window.miks`, which Electron's preload gives Miks's own windows, as a
// WebSocket to the page's own server, which pipes it to the daemon. Imported
// first, before anything reads `window.miks`.
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import type { MiksBridge } from "./daemon";

/** This device's own settings (the sidebar, the text size), kept in the browser, not the Mac's. */
const SETTINGS_KEY = "miks-settings";

/** How long a dropped connection waits before trying again. */
const RETRY_DELAY = 2000;

if (!window.miks && /^https?:$/.test(location.protocol)) window.miks = webBridge();

function webBridge(): MiksBridge {
  const messageListeners = new Set<(message: string) => void>();
  const statusListeners = new Set<(status: { connected: boolean; error?: string; retrying?: boolean }) => void>();
  const settingsListeners = new Set<(settings: Settings) => void>();
  const subscribe = <T>(set: Set<T>, listener: T) => (set.add(listener), () => void set.delete(listener));

  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (retry) clearTimeout(retry);
    retry = null;
    socket?.close();
    const next = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket = next;
    next.onopen = () => statusListeners.forEach((listener) => listener({ connected: true }));
    next.onmessage = (event) => messageListeners.forEach((listener) => listener(String(event.data)));
    next.onclose = () => {
      if (socket !== next) return;
      socket = null;
      statusListeners.forEach((listener) =>
        listener({ connected: false, retrying: true, error: `Reconnecting to Miks on ${location.hostname}…` }),
      );
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
