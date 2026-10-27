// The renderer's only door to the daemon, exposed as `window.miks` (typed in
// packages/ui/bridge.ts). CommonJS because sandboxed preloads can't be ESM.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("miks", {
  /** (Re)connects this page to the daemon; status arrives via onStatus. */
  connect: () => ipcRenderer.send("miks:connect"),
  send: (message) => ipcRenderer.send("miks:send", message),
  onMessage: (listener) => subscribe("miks:message", listener),
  onStatus: (listener) => subscribe("miks:status", listener),
  onCommand: (listener) => subscribe("miks:command", listener),
  /** Settings are read synchronously, so the first render already has them. */
  getSettings: () => ipcRenderer.sendSync("miks:getSettings"),
  setSettings: (changes) => ipcRenderer.send("miks:setSettings", changes),
  onSettings: (listener) => subscribe("miks:settings", listener),
  /** The Mac this window's daemon is on: null for this one, else { name, color, host }. */
  getTarget: () => ipcRenderer.sendSync("miks:getTarget"),
  onTarget: (listener) => subscribe("miks:target", listener),
  /** What this window is and where, for `miks version`. */
  client: () => ipcRenderer.sendSync("miks:client"),
  /** Opens (or brings forward) the window on a remote from Settings. */
  openRemote: (id) => ipcRenderer.send("miks:openRemote", id),
  /** The other Macs on this Mac's tailnet, for adding one: `{ macs }`, or `{ error }` saying why there are none. */
  tailnetMacs: () => ipcRenderer.invoke("miks:tailnetMacs"),
  /** A native confirmation on this window; resolves true for its button. */
  confirm: (options) => ipcRenderer.invoke("miks:confirm", options),
  /** Puts text on this Mac's clipboard (a program asked, by OSC 52). */
  copy: (text) => ipcRenderer.send("miks:copy", text),
  /** Brings this window forward (a notification was clicked). */
  focus: () => ipcRenderer.send("miks:focus"),
  /** The path of a dropped file; File.path no longer exists in Electron. */
  pathForFile: (file) => webUtils.getPathForFile(file),
  /** Copies dropped files to a temporary folder (on a remote window's Mac) or the tab's; resolves with where. */
  sendFiles: (tabId, paths, into) => ipcRenderer.invoke("miks:sendFiles", tabId, paths, into),
  sendClipboardImage: (tabId) => ipcRenderer.invoke("miks:sendClipboardImage", tabId),
  /** The session for this window's `miks browse` pages, set up to go through its daemon. */
  browsePartition: () => ipcRenderer.invoke("miks:browsePartition"),
  /** Asks for an app to open links in; resolves with its path, or null. */
  chooseBrowser: () => ipcRenderer.invoke("miks:chooseBrowser"),
});

function subscribe(channel, listener) {
  const handler = (_event, value) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
