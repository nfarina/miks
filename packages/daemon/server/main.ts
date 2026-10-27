import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { logPath, socketPath, statePath } from "../shared/paths.ts";
import { serve } from "./daemon.ts";
import { Gateway } from "./Gateway.ts";
import { Keeper } from "./Keeper.ts";

const [command] = process.argv.slice(2);

if (command === "serve") {
  // What `ps` and `pkill` see, instead of the binary it runs on.
  process.title = "miks-daemon";

  // The launchd job the UI started us as, if any (see startDaemon in the app).
  const job = process.env.MIKS_DAEMON_JOB;

  let stopping = false;
  let closed = false;
  const daemon = await serve({
    socketPath: socketPath(),
    statePath: statePath(),
    onStop: (restart) => {
      if (stopping) return;
      stopping = true;
      log(restart ? "Restarting." : "The last window left after Miks quit; exiting.");
      daemon.close().finally(() => {
        closed = true;
        // The same daemon again, from the same files (so any new code), once
        // this one has let go of the socket. It restores the saved layout.
        if (restart && job) {
          // Through launchd, which stops us (SIGTERM) and starts the job
          // again: a daemon we spawned would be ours, and macOS would hold
          // its terminals to us once we're gone, failing their connections
          // to the local network at random.
          spawn("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${job}`], {
            detached: true,
            stdio: "ignore",
          }).unref();
          return;
        }
        if (restart) {
          const output = fs.openSync(logPath(), "a");
          spawn(process.execPath, process.argv.slice(1), { detached: true, stdio: ["ignore", output, output] }).unref();
        }
        process.exit(0);
      });
    },
  });

  // Start with something to look at.
  if (!daemon.restored) daemon.workspaces.createWorkspace();

  // Your other devices on Tailscale, while Settings allows them: the built UI
  // (in the repo, or the app bundle) and a pipe to the socket.
  const gateway = new Gateway({
    socketPath: socketPath(),
    uiDir: path.resolve(import.meta.dirname, "../../ui/dist"),
  });
  gateway.on("change", () => daemon.workspaces.setGateway(gateway.state));
  // As this Mac's settings say (machine.json), which any window on this daemon changes.
  // And while you're away from it (keepAvailable), as long as it's plugged in.
  const keeper = new Keeper(log);
  keeper.on("change", () => daemon.workspaces.setKeeper(keeper.state));
  const followSettings = () => {
    const settings = daemon.workspaces.getMachineSettings();
    gateway.setEnabled(settings.tailnetAccess);
    keeper.setMode(settings.keepAvailable);
  };
  followSettings();
  daemon.workspaces.on("machine", followSettings);

  log(`Listening on ${socketPath()} (pid ${process.pid}).`);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      // Closing twice would save the layout again, emptied.
      if (closed) process.exit(0);
      if (stopping) return;
      stopping = true;
      log(`Got ${signal}; exiting.`);
      daemon.close().finally(() => process.exit(0));
    });
  }
} else {
  console.error("Usage: miks serve");
  process.exit(1);
}

function log(message: string) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  if (!process.stdout.isTTY) return;
  // When run by hand, also keep the log the UI-spawned daemon would write.
  fs.appendFileSync(logPath(), line);
}
