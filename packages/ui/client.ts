// Which Miks this window is, sent with every `hello` for `miks version`
// (`ClientInfo`): its UI's build, and what the bridge says it is and where.
import type { Build, ClientInfo } from "miks/shared/protocol";

declare const __MIKS_BUILD__: Build & { dev?: boolean };

/** This UI's build, stamped by vite.config.ts (missing under vitest). */
export const UI_BUILD: ClientInfo["ui"] = typeof __MIKS_BUILD__ === "undefined" ? { version: "?", commit: null, built: null } : __MIKS_BUILD__;

export function clientInfo(): ClientInfo {
  return { kind: "browser", machine: deviceName(), ...window.miks?.client?.(), ui: UI_BUILD };
}

/** What a browser can tell of the device it's on. */
export function deviceName(): string {
  const agent = navigator.userAgent;
  // iPadOS's Safari says it's a Mac.
  if (/iPad/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/iPhone/.test(agent)) return "iPhone";
  if (/Android/.test(agent)) return "Android";
  if (/Macintosh/.test(agent)) return "a Mac";
  if (/Windows/.test(agent)) return "Windows";
  return "a device";
}
