import fs from "fs";
import path from "path";
import { DEFAULT_SETTINGS, KEEP_AVAILABLE, MACHINE_SETTINGS, type MachineSettings } from "../shared/settings.ts";

/**
 * This Mac's settings for every window on its daemon (shared/settings.ts),
 * in `machine.json` in Miks's home. The daemon's alone: settings.json is the
 * Mac app's, which writes its whole copy back on any change. The first time,
 * from what settings.json had.
 */
export function loadMachineSettings(home: string): MachineSettings {
  const defaults = only(DEFAULT_SETTINGS);
  for (const file of ["machine.json", "settings.json"]) {
    try {
      return { ...defaults, ...only(JSON.parse(fs.readFileSync(path.join(home, file), "utf8"))) };
    } catch {}
  }
  return defaults;
}

export function saveMachineSettings(home: string, settings: MachineSettings) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "machine.json"), JSON.stringify(settings, null, 2));
}

/** Just the machine's settings, each only if it's the right type. */
export function only(source: Record<string, unknown>): MachineSettings {
  const settings: Record<string, unknown> = {};
  for (const key of MACHINE_SETTINGS) {
    if (typeof source?.[key] === typeof DEFAULT_SETTINGS[key]) settings[key] = source[key];
  }
  if (settings.keepAvailable !== undefined && !KEEP_AVAILABLE.includes(settings.keepAvailable as never)) delete settings.keepAvailable;
  return settings as MachineSettings;
}
