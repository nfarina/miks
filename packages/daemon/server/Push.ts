import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import type { AgentStatus, DaemonState, PushDevice } from "../shared/protocol.ts";

/** The relay that holds the APNs key (push/worker.js). */
const RELAY = "https://miks-push.nfarina.com";

/** How long someone at this Mac has to see a tab before it goes to their devices. */
const DELAY = 60_000;

/** Idle this long (no keys, mouse or trackpad), nobody's at this Mac: push at once. */
const AWAY = 60_000;

type Sender = (body: object) => Promise<{ ok?: boolean; gone?: boolean; error?: string }>;

/**
 * Push notifications to the iOS app, for an agent that needs you or is done,
 * as Messages does it: with someone at this Mac, it's the Mac's to show
 * (its windows notify), and goes to their devices only if the tab hasn't
 * been looked at a minute later; with nobody, at once. Never to a device
 * showing this Mac right now. Once the tab's been looked at anywhere, its
 * notification goes from every device it went to (`clear_threads`, in the
 * tab's thread: its `key`).
 *
 * Devices register through any window (`device`), and are kept in
 * `devices.json` in Miks's home, until the relay says one's gone.
 */
export class Push {
  private readonly devices = new Map<string, PushDevice>();
  private readonly file: string;
  private readonly send: Sender;
  private readonly idleTime: () => Promise<number>;
  private readonly onScreen: (deviceId: string) => boolean;
  private readonly delay: number;

  /** Each tab's status as last seen, by id; null until the first state. */
  private statuses: Map<string, AgentStatus | undefined> | null = null;
  /** Pushes on their way (checking idle, or waiting out the delay), by tab id. */
  private readonly pending = new Map<string, { timer?: ReturnType<typeof setTimeout> }>();
  /** Pending tabs a window here has shown, which counts only if someone touches this Mac meanwhile. */
  private readonly shownAtMac = new Set<string>();
  /** What's been pushed for each tab (by id): its thread, and the devices it went to. */
  private readonly pushed = new Map<string, { thread: string; devices: Set<string> }>();

  constructor({
    home,
    onScreen,
    send = relaySend,
    idleTime = macIdleTime,
    delay = DELAY,
  }: {
    home: string;
    /** Whether the device has a window showing this Mac. */
    onScreen: (deviceId: string) => boolean;
    send?: Sender;
    idleTime?: () => Promise<number>;
    delay?: number;
  }) {
    this.file = path.join(home, "devices.json");
    this.onScreen = onScreen;
    this.send = send;
    this.idleTime = idleTime;
    this.delay = delay;
    try {
      for (const device of JSON.parse(fs.readFileSync(this.file, "utf8")) as PushDevice[]) {
        this.devices.set(device.deviceId, device);
      }
    } catch {}
  }

  /** A device's registration (or a newer one, replacing it). */
  register(device: PushDevice) {
    const known = this.devices.get(device.deviceId);
    if (known && JSON.stringify(known) === JSON.stringify(device)) return;
    this.devices.set(device.deviceId, device);
    this.save();
  }

  /** Follows every change of state: a new `waiting` or `done` pushes, one going ends it. */
  update(state: DaemonState) {
    const statuses = new Map<string, AgentStatus | undefined>();
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) statuses.set(tab.id, tab.agent?.status);
    }

    const before = this.statuses;
    this.statuses = statuses;
    // What was already so when the daemon started was never news.
    if (!before) return;

    // Answered, or closed. Not `done` going idle: that's a window saying it
    // was seen, which comes here itself (seen, seenAtMac) when it counts.
    for (const tabId of new Set([...before.keys(), ...this.pending.keys(), ...this.pushed.keys()])) {
      const [was, status] = [before.get(tabId), statuses.get(tabId)];
      if (status === was || status === "waiting" || status === "done") continue;
      if (was === "done" && status === "idle") continue;
      this.seen(tabId);
    }

    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        const status = tab.agent?.status;
        if ((status !== "waiting" && status !== "done") || before.get(tab.id) === status) continue;
        if (!before.has(tab.id)) continue;

        const title = workspace.title ?? (tab.title.replace(/^\p{So}\s+/u, "") || "Terminal");
        const body =
          status === "waiting"
            ? (tab.agent?.message ?? "Needs your input")
            : plainText(tab.agent?.reply ?? "") || "Done";
        void this.schedule(tab.id, { title, body, thread: tab.key ?? tab.id });
      }
    }
  }

  /**
   * The tab's been looked at (or answered, or closed): no push for it, and
   * any it had goes from every device.
   */
  seen(tabId: string) {
    const timer = this.pending.get(tabId)?.timer;
    if (timer) clearTimeout(timer);
    this.pending.delete(tabId);
    this.shownAtMac.delete(tabId);

    const pushed = this.pushed.get(tabId);
    if (!pushed) return;
    this.pushed.delete(tabId);
    for (const deviceId of pushed.devices) {
      const device = this.devices.get(deviceId);
      if (device) void this.deliver(device, { clear: [pushed.thread] });
    }
  }

  /**
   * Seen in a window on this Mac, which counts only with someone at it: a
   * window left focused on the tab says it's seen the moment it changes,
   * often as you walk away. So while its push waits out the delay, it's
   * called off only if this Mac is touched before then; after it's gone
   * out, only if someone's at the Mac now.
   */
  async seenAtMac(tabId: string) {
    // Most are a window in use, about a tab with nothing pushed (App.tsx).
    if (!this.pending.has(tabId) && !this.pushed.has(tabId)) return;
    if (this.pending.has(tabId)) {
      this.shownAtMac.add(tabId);
      return;
    }
    if ((await this.idleTime().catch(() => 0)) < AWAY) this.seen(tabId);
  }

  close() {
    for (const { timer } of this.pending.values()) if (timer) clearTimeout(timer);
    this.pending.clear();
  }

  private async schedule(tabId: string, alert: { title: string; body: string; thread: string }) {
    if (this.devices.size === 0) return;
    const previous = this.pending.get(tabId)?.timer;
    if (previous) clearTimeout(previous);
    // In place before the idle check, so a `seen` meanwhile calls it off.
    const entry: { timer?: ReturnType<typeof setTimeout> } = {};
    this.pending.set(tabId, entry);

    const away = (await this.idleTime().catch(() => 0)) >= AWAY;
    if (this.pending.get(tabId) !== entry) return;
    entry.timer = setTimeout(
      async () => {
        // A window here showed it: seen, if anyone's touched this Mac since.
        if (!away && this.shownAtMac.has(tabId) && (await this.idleTime().catch(() => 0)) < this.delay) {
          return this.seen(tabId);
        }
        if (this.pending.get(tabId) !== entry) return;
        this.pending.delete(tabId);
        this.shownAtMac.delete(tabId);
        this.pushNow(tabId, alert);
      },
      away ? 0 : this.delay,
    );
    entry.timer.unref?.();
  }

  private pushNow(tabId: string, alert: { title: string; body: string; thread: string }) {
    const devices = [...this.devices.values()].filter((device) => !this.onScreen(device.deviceId));
    if (devices.length === 0) return;
    const pushed = this.pushed.get(tabId) ?? { thread: alert.thread, devices: new Set<string>() };
    this.pushed.set(tabId, pushed);
    for (const device of devices) {
      pushed.devices.add(device.deviceId);
      void this.deliver(device, {
        alert: { ...alert, subtitle: macName(device.host), mac: device.host, tabId },
      });
    }
  }

  private async deliver(device: PushDevice, body: { alert?: object; clear?: string[] }) {
    const result: Awaited<ReturnType<Sender>> = await this.send({ id: device.id, ...body }).catch((error) => ({
      error: String(error?.message ?? error),
    }));
    if (result.gone && this.devices.get(device.deviceId)?.id === device.id) {
      this.devices.delete(device.deviceId);
      this.save();
    } else if (result.error) {
      console.error(`Couldn't push to ${device.name}: ${result.error}`);
    }
  }

  private save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    } catch (error) {
      console.error("Couldn't save devices.json:", error);
    }
  }
}

async function relaySend(body: object) {
  const response = await fetch(`${RELAY}/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await response.json().catch(() => ({ error: `The relay answered ${response.status}.` }))) as Awaited<
    ReturnType<Sender>
  >;
}

/** How long since anyone touched this Mac's keyboard, mouse or trackpad (ms), as IOKit counts it. */
export function macIdleTime(): Promise<number> {
  return new Promise((resolve) => {
    execFile("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-d", "4"], (error, stdout) => {
      const nanoseconds = !error && stdout.match(/"HIDIdleTime" = (\d+)/)?.[1];
      resolve(nanoseconds ? Number(nanoseconds) / 1e6 : 0);
    });
  });
}

/** "air" for "air.tailbf8edc.ts.net:2741", as the app's switcher says it. */
function macName(host: string): string {
  return host.split(".")[0].split(":")[0];
}

/** Claude's markdown reply, near enough as text: a notification shows a line or two. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[^\n]*\n?/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/(\*\*|__|\*|_|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
