import { type ChildProcess, execFile, spawn } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import type { KeeperState } from "../shared/protocol.ts";
import type { KeepAvailable } from "../shared/settings.ts";

const KEEPER_DIR = path.resolve(import.meta.dirname, "../keeper");
/** Built in the bundle by build-app.ts; in the repo, here, as the source changes. */
const BINARY = path.join(KEEPER_DIR, "build/miks-keeper");
const SOURCE = path.join(KEEPER_DIR, "Keeper.swift");

/**
 * Keeps this Mac available to your other devices while you're away, as its
 * `keepAvailable` setting says. `locked` is `caffeinate -s`: no sleep while
 * plugged in, and the Mac locks as usual. `unlocked` is the keeper
 * (keeper/Keeper.swift), which also keeps it from locking, with a sheet of
 * its own instead. Either is a child of the daemon, and so goes with it
 * (`-w`, or the keeper's stdin closing).
 *
 * The keeper fails locked: if it dies with the sheet up, this locks the Mac
 * for real (`miks-keeper lock`) before starting another.
 */
export class Keeper extends EventEmitter<{ change: [] }> {
  private mode: KeepAvailable = "off";
  // The one running now: any other going was stopped, not a crash.
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | undefined;
  state: KeeperState | undefined;

  private readonly log: (message: string) => void;

  constructor(log: (message: string) => void) {
    super();
    this.log = log;
  }

  setMode(mode: KeepAvailable) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.stop();
    void this.start();
  }

  stop() {
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    if (!child) return;
    // The keeper locks the Mac first if the sheet's up.
    if (child.stdin?.writable) child.stdin.end("quit\n");
    else child.kill();
    this.setState(undefined);
  }

  private async start() {
    const mode = this.mode;
    if (mode === "off") return;
    const binary = mode === "unlocked" ? await built(this.log) : null;
    // Changed while it built.
    if (mode !== this.mode || this.child) return;

    if (!binary) {
      // `locked`, or a keeper that couldn't be built (which then does what `locked` does).
      const child = spawn("/usr/bin/caffeinate", ["-s", "-w", String(process.pid)], { stdio: "ignore" });
      this.child = child;
      child.on("exit", () => this.exited(child));
      return;
    }

    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let buffered = "";
    child.stdout!.on("data", (data: Buffer) => {
      buffered += data.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop()!;
      for (const line of lines) {
        try {
          this.setState(JSON.parse(line));
        } catch {}
      }
    });
    child.stderr!.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) if (line.trim()) this.log(line.trim());
    });
    child.stdin!.on("error", () => {});
    child.on("exit", (code, signal) => {
      if (this.child === child) this.log(`The keeper exited (${signal ?? code}).`);
      this.exited(child);
    });
  }

  /** A child gone by itself (a crash): locked for real if the screen was dark, then started again. */
  private exited(child: ChildProcess) {
    if (this.child !== child) return;
    this.child = null;
    if (this.state?.shielded) {
      this.log("The keeper went with the screen dark: locking.");
      execFile(BINARY, ["lock"]);
    }
    this.setState(undefined);
    this.restartTimer = setTimeout(() => void this.start(), 3000);
  }

  private setState(state: KeeperState | undefined) {
    this.state = state;
    this.emit("change");
  }
}

/**
 * The keeper, built from its source when that's newer (in the repo; the
 * bundle has no source, only what build-app.ts built). Null if there's none.
 */
async function built(log: (message: string) => void): Promise<string | null> {
  const mtime = (file: string) => fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (fs.existsSync(SOURCE) && mtime(SOURCE) > mtime(BINARY)) {
    log("Building the keeper…");
    fs.mkdirSync(path.dirname(BINARY), { recursive: true });
    try {
      await promisify(execFile)("swiftc", ["-O", SOURCE, "-o", BINARY]);
    } catch (error) {
      log(`Couldn't build the keeper: ${(error as Error).message}`);
    }
  }
  return fs.existsSync(BINARY) ? BINARY : null;
}
