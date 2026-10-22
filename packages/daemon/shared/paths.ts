import os from "os";
import path from "path";

/**
 * Where Miks keeps its socket, state, and log. `MIKS_HOME` overrides it, so
 * tests and experiments can run a second daemon without touching the real one.
 */
export function miksHome(): string {
  return process.env.MIKS_HOME ?? path.join(os.homedir(), "Library/Application Support/Miks");
}

export function socketPath(): string {
  return path.join(miksHome(), "miks.sock");
}

export function logPath(): string {
  return path.join(miksHome(), "daemon.log");
}

/** The app's preferences, written by the Electron main process; the daemon reads some. */
export function settingsPath(): string {
  return path.join(miksHome(), "settings.json");
}

/** The layout to restore when the daemon starts. */
export function statePath(): string {
  return path.join(miksHome(), "state.json");
}
