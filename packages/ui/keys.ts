import { useSyncExternalStore } from "react";

/**
 * Ctrl, from the bar: the next character typed into a terminal goes as its
 * control key (C as ⌃C). Tapped twice, it stays on until tapped again.
 */
let ctrl: "off" | "once" | "locked" = "off";
const ctrlListeners = new Set<() => void>();
export const setCtrl = (next: typeof ctrl) => {
  ctrl = next;
  for (const listener of ctrlListeners) listener();
};

/** What a terminal sends for what was typed, with Ctrl applied if it's on. */
export function withModifiers(data: string): string {
  if (ctrl === "off" || data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  // ⌃@ through ⌃_ (letters among them), ⌃Space as ⌃@, ⌃? as Delete.
  const control = code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data === " " ? "\x00" : data === "?" ? "\x7f" : null;
  if (control === null) return data;
  if (ctrl === "once") setCtrl("off");
  return control;
}

/** Whether Ctrl is on, for the bar's key. */
export function useCtrl() {
  return useSyncExternalStore(
    (listener) => {
      ctrlListeners.add(listener);
      return () => ctrlListeners.delete(listener);
    },
    () => ctrl,
  );
}
