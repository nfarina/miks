import { openExternalLink } from "./openExternalLink.js";
import { HostContact, HostContainer, HostFeatures } from "./types.js";

//
// Container Detection
//

const container = detectContainer();

declare var global: any;

export function detectContainer(): HostContainer {
  if (
    typeof window !== "undefined" &&
    (window as any).webkit &&
    (window as any).webkit.messageHandlers &&
    (window as any).webkit.messageHandlers.default
  ) {
    return "ios";
  } else if (typeof window !== "undefined" && window["android"]) {
    return "android";
  } else if (typeof global !== "undefined" && global.require) {
    return "electron";
  } else if (
    typeof window !== "undefined" &&
    "standalone" in window.navigator &&
    window.navigator.standalone
  ) {
    return "webapp";
  } else {
    return "web";
  }
}

//
// Known IPC Methods
//

export async function getFeatures(): Promise<HostFeatures> {
  if (canSend()) {
    return (await send("getFeatures")) as HostFeatures;
  } else {
    return {}; // Default is an empty "features" dict.
  }
}

export const supportsLog = () => ["ios", "electron"].includes(container);

export async function log(prefix: string, ...args: any) {
  const message = args
    .map((arg) => (typeof arg !== "string" ? JSON.stringify(arg) : arg))
    .join(" ");
  post("log", { prefix, message });
}

export async function openUrl(url: string) {
  if (container === "ios") {
    // Because of seemingly-new security restrictions on iOS 13, our typical
    // hack of simulating a click on an <a> element won't work anymore. So we
    // need to ask the native host to just do it.
    post("openUrl", { url });
  } else {
    // Do it old-school.
    openExternalLink(url);
  }
}

export async function login(token: string) {
  post("login", { token });
}

// For Android devices; simulates pressing the back button.
export async function goBack() {
  post("goBack");
}

export async function sendSignInLink(email: string, url: string) {
  const result = (await send("sendSignInLink", { email, url })) as {
    error?: string;
  };
  if (result.error) throw new Error(result.error);
}

export async function requestNotificationAuthorization() {
  post("requestNotificationAuthorization");
}

export async function requestLocationWhenInUseAuthorization() {
  post("requestLocationWhenInUseAuthorization");
}

export async function requestLocationUpdate() {
  post("requestLocationUpdate");
}

export async function requestTemporaryFullAccuracyLocationAuthorization({
  purposeKey,
}: {
  purposeKey: string;
}) {
  post("requestTemporaryFullAccuracyLocationAuthorization", { purposeKey });
}

export async function openSettings() {
  post("openSettings");
}

export async function requestReview() {
  post("requestReview");
}

export async function badgeAppIcon(badge: number) {
  post("badgeAppIcon", { badge });
}

export async function clearReadNotifications({ unreadThreads }: { unreadThreads: string[] }) {
  post("clearReadNotifications", { unreadThreads });
}

export async function copyToClipboard(text: string) {
  post("copyToClipboard", { text });
}

export async function readFromClipboard(): Promise<string> {
  const result = (await send("readClipboard")) as { text?: string };
  return result.text ?? "";
}

export async function showShareSheet(text: string) {
  post("showShareSheet", { text });
}

export async function shareFile(args: {
  /** Base64-encoded file contents (no data: prefix). */
  data: string;
  fileName: string;
  mimeType: string;
}) {
  // Use send() so the returned Promise resolves once the host has actually
  // presented the share sheet (lets the caller show a working state).
  await send("shareFile", args);
}

export async function printUrl(args: { url: string; jobName?: string }) {
  // Use send() so the returned Promise resolves once the print sheet is
  // actually on screen. Printing a URL means the host has to fetch and render
  // the page first, which is slow enough that the caller wants to show a
  // working state until it's up.
  await send("printUrl", args);
}

export async function showMessageSheet(args: { to: string; body: string }) {
  post("showMessageSheet", args);
}

export async function showEmailSheet(args: {
  to: string;
  subject: string;
  body: string;
  isHTML: boolean;
}) {
  post("showEmailSheet", args);
}

export async function getContacts() {
  const start = Date.now();
  const result = await send("getContacts");
  const end = Date.now();
  console.log(`Took ${end - start}ms to load contacts.`);
  const {
    contacts,
    error,
  }: {
    contacts?: HostContact[];
    error?: string;
  } = result;

  if (error) {
    throw new Error(error);
  }

  return contacts || [];
}

export async function setWakeLock(on: boolean): Promise<void> {
  post("setWakeLock", { on });
}

export async function getBrightness(): Promise<number> {
  const result: any = await send("getBrightness");
  return result.level;
}

export async function setBrightness(level: number): Promise<void> {
  post("setBrightness", { level });
}

export async function setLightStatusBar(light: boolean): Promise<void> {
  post("onStatusBarStyleChange", { style: light ? "light" : "normal" });
}

export async function startSmsRetriever() {
  post("startSmsRetriever");
}

export async function openPlaid({
  token,
  redirectUri,
}: {
  token: string;
  redirectUri?: string | null;
}) {
  post("openPlaid", { token, redirectUri });
}

export async function closePlaid() {
  post("closePlaid");
}

export async function delayUpdates(duration: number) {
  post("delayUpdates", { duration });
}

//
// IPC Implementation
//

// These have to be on the window object so native code can evaluate Javascript
// referencing them.
if (typeof window !== "undefined") {
  window["NEXT_HOST_CALLBACK_ID"] = 0;
  window["HOST_CALLBACKS"] = {};
}

const canPost = () => ["ios", "android", "electron"].includes(container);

/**
 * Posts a message without waiting for a response.
 */
export function post(name: string, args?: object) {
  if (!canPost()) {
    console.log(`Container "${container}" is ignoring ipc.post("${name}") with args.`, args);
    return;
  }

  const message = { name, ...args };

  switch (container) {
    case "ios":
      window["webkit"].messageHandlers.default.postMessage(message);
      break;
    case "android":
      window["android"].postMessage(JSON.stringify(message));
      break;
    case "electron":
      const { ipcRenderer } = global.require("electron");
      ipcRenderer.send("asynchronous-message", message);
      break;
  }
}

export function canSend() {
  // Only iOS and Android currently support callbacks.
  return ["ios", "android"].includes(container);
}

/**
 * Sends a message and returns a Promise for an expected response.
 */
export async function send(name: string, args?: object): Promise<object> {
  if (!canSend()) {
    console.log(`Container "${container}" is ignoring ipc.send("${name}") with args.`, args);
    return {};
  }

  return new Promise((resolve, reject) => {
    // Wrap the callback so we can reject the promise if there's an error.
    const callbackWrapper = (result?: any) => {
      // We support result types that are objects with an optional error
      // property.
      if (result && result.error) {
        reject(new Error(result.error));
      } else {
        resolve(result);
      }
    };

    window["NEXT_HOST_CALLBACK_ID"] += 1;
    const callbackID = window["NEXT_HOST_CALLBACK_ID"];
    window["HOST_CALLBACKS"][callbackID] = callbackWrapper;

    const callback = `window.HOST_CALLBACKS[${callbackID}]`;

    post(name, { callback, ...args });
  });
}
