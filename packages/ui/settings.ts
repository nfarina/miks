// The app's settings, as the main process keeps them (packages/app/main.ts),
// live in every window: a change in Settings shows up everywhere at once.
import { COARSE_POINTER_QUERY } from "crosswing/host/pointer";
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import { useSyncExternalStore } from "react";
import { hardwareKeyboard } from "./webBridge";

export { displayPath } from "miks/shared/settings";

const bridge = window.miks;
const listeners = new Set<() => void>();
let current: Settings = bridge?.getSettings() ?? DEFAULT_SETTINGS;

bridge?.onSettings((settings) => {
  current = settings;
  for (const listener of listeners) listener();
});

export function getSettings(): Settings {
  return current;
}

export function updateSettings(changes: Partial<Settings>) {
  bridge?.setSettings(changes);
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
