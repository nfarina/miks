// The app's settings, as the main process keeps them (packages/app/main.ts),
// live in every window: a change in Settings shows up everywhere at once.
// The machine's ones (MACHINE_SETTINGS) come from the window's daemon, which
// keeps them for every window on its Mac, a remote's and the iOS app's too.
import { COARSE_POINTER_QUERY } from "crosswing/host/pointer";
import { DEFAULT_SETTINGS, MACHINE_SETTINGS, type MachineSettings, type Settings } from "miks/shared/settings";
import { useSyncExternalStore } from "react";
import { daemon } from "./daemon";
import { hardwareKeyboard } from "./webBridge";

export { displayPath } from "miks/shared/settings";

const bridge = window.miks;
const listeners = new Set<() => void>();
let own: Settings = bridge?.getSettings() ?? DEFAULT_SETTINGS;
let machine: MachineSettings | undefined;
let current: Settings = own;

function refresh() {
  current = machine ? { ...own, ...machine } : own;
  for (const listener of listeners) listener();
}

bridge?.onSettings((settings) => {
  own = settings;
  refresh();
});

// Every state has them, so only when they've changed.
daemon.subscribe(() => {
  const next = daemon.getSnapshot().state?.machine;
  if (next === machine || (next && machine && MACHINE_SETTINGS.every((key) => next[key] === machine![key]))) return;
  machine = next;
  refresh();
});

export function getSettings(): Settings {
  return current;
}

export function updateSettings(changes: Partial<Settings>) {
  // The machine's to its daemon, unless it's older than that.
  const machineChanges: Partial<Record<string, unknown>> = {};
  const rest: Partial<Record<string, unknown>> = { ...changes };
  if (daemon.speaks(11)) {
    for (const key of MACHINE_SETTINGS) {
      if (key in changes) {
        machineChanges[key] = changes[key];
        delete rest[key];
      }
    }
  }
  if (Object.keys(machineChanges).length > 0) daemon.send({ type: "machineSettings", changes: machineChanges as Partial<MachineSettings> });
  if (Object.keys(rest).length > 0) bridge?.setSettings(rest as Partial<Settings>);
}

export function useSettings(): Settings {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/**
 * Whether settings are this device's own (a browser's, the iOS app's, in
 * localStorage), not the Mac app's: only how it looks and types apply.
 */
export const DEVICE_SETTINGS = !navigator.userAgent.includes("Electron");

/**
 * Whether to put the keyboard somewhere on our own (a terminal coming on
 * screen, a dialog closing): not on a touch screen, where focusing brings up
 * the on-screen keyboard over half of it, unless the iOS app says there's a
 * hardware keyboard. Otherwise, only a tap does.
 */
export function autoFocus(): boolean {
  return !(DEVICE_SETTINGS && matchMedia(COARSE_POINTER_QUERY).matches) || hardwareKeyboard();
}

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

export function setFontSize(size: number) {
  updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) });
}
