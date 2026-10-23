// The app's settings, as the main process keeps them (packages/app/main.ts),
// live in every window: a change in Settings shows up everywhere at once.
import { DEFAULT_SETTINGS, type Settings } from "miks/shared/settings";
import { useSyncExternalStore } from "react";

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

const MIN_FONT_SIZE = 8;
const MAX_FONT_SIZE = 32;

export function setFontSize(size: number) {
  updateSettings({ fontSize: Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, size)) });
}
