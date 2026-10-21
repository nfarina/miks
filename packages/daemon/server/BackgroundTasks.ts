import { execFile } from "child_process";
import { EventEmitter } from "events";
import fs from "fs";
import type { Background } from "../shared/protocol.ts";

/** How often the transcript is checked for more, as for the chat panel. */
const POLL_INTERVAL = 250;

/** How often running shells and monitors are checked for having ended without a word. */
const CHECK_INTERVAL = 3000;

type Task =
  | { kind: "shell"; outputFile?: string }
  | { kind: "monitor"; expires?: number }
  | { kind: "agent" };

/**
 * What a Claude Code session has going in the background (its "1 shell, 1
 * monitor"), read from its transcript, which has no hook for it. Each
 * starts with its tool's result (`toolUseResult`: `backgroundTaskId` for a
 * shell, `taskId` and `timeoutMs` for a monitor, `async_launched` for an
 * agent) and ends with a `<task-notification>` carrying a `<status>`, written
 * as soon as it ends (a `queue-operation` line), even mid-turn.
 *
 * Some ends leave no such mark (stopped from Claude Code's task list, say),
 * so a shell also ends once no process has its output file open (its own
 * shell writes to it), and a monitor at its deadline, when Claude Code kills
 * it anyway. Agents run inside Claude Code; theirs is the notification.
 *
 * Read from where the file ends when it's first followed: whatever an
 * earlier Claude Code process started ended with it.
 */
export class BackgroundTasks extends EventEmitter<{ change: [] }> {
  private readonly tasks = new Map<string, Task>();
  private file: string | null = null;
  private offset = 0;
  private partial = "";
  private reading = false;
  private readAgain = false;
  private checking = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly checkInterval: number;

  constructor({ checkInterval = CHECK_INTERVAL }: { checkInterval?: number } = {}) {
    super();
    this.checkInterval = checkInterval;
  }

  /** Follows the session's transcript, from its end; a new session (`/clear`) keeps what's running. */
  follow(file: string) {
    if (file === this.file) return;
    this.unwatch();
    this.file = file;
    try {
      this.offset = fs.statSync(file).size;
    } catch {
      this.offset = 0;
    }
    this.partial = "";
    fs.watchFile(file, { interval: POLL_INTERVAL, persistent: false }, () => void this.read());
  }

  /** How many of each are running, or nothing when none are. */
  counts(): Background | undefined {
    if (this.tasks.size === 0) return undefined;
    const counts: Background = { shells: 0, monitors: 0, agents: 0 };
    for (const task of this.tasks.values()) counts[`${task.kind}s`]++;
    return counts;
  }

  close() {
    this.unwatch();
    this.removeAllListeners();
    this.tasks.clear();
  }

  private unwatch() {
    if (this.file) fs.unwatchFile(this.file);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async read() {
    if (this.reading) {
      this.readAgain = true;
      return;
    }
    this.reading = true;
    try {
      do {
        this.readAgain = false;
        await this.readMore();
      } while (this.readAgain);
    } catch {
      // Unreadable for now: the next change tries again.
    } finally {
      this.reading = false;
    }
  }

  private async readMore() {
    const file = this.file;
    if (!file) return;
    const size = (await fs.promises.stat(file)).size;
    if (size < this.offset) {
      this.offset = 0;
      this.partial = "";
    }
    if (size === this.offset) return;

    let changed = false;
    const stream = fs.createReadStream(file, { start: this.offset, end: size - 1, encoding: "utf8", highWaterMark: 1 << 20 });
    for await (const chunk of stream) {
      if (file !== this.file) return stream.destroy();
      const lines = (this.partial + chunk).split("\n");
      this.partial = lines.pop()!;
      for (const line of lines) changed = this.addLine(line) || changed;
    }
    this.offset = size;
    if (changed) this.changed();
  }

  /** Whether the line started or ended something. Most lines are neither, and aren't parsed. */
  private addLine(line: string): boolean {
    let changed = false;

    // Ends, wherever they're mentioned: an id that isn't running is no harm.
    if (line.includes("<task-notification>")) {
      for (const notice of line.split("<task-notification>").slice(1)) {
        const id = notice.match(/<task-id>([\w-]+)<\/task-id>/)?.[1];
        if (id && /<status>\w+<\/status>/.test(notice) && this.tasks.delete(id)) changed = true;
      }
    }

    if (!line.includes('"toolUseResult"') || !/"backgroundTaskId"|"timeoutMs"|"async_launched"/.test(line)) return changed;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return changed;
    }
    const result = record?.toolUseResult;
    if (!result || typeof result !== "object" || record.isSidechain) return changed;

    if (typeof result.backgroundTaskId === "string") {
      const text = JSON.stringify(record.message?.content ?? "");
      const outputFile = text.match(/Output is being written to: (.+?\.output)/)?.[1];
      this.tasks.set(result.backgroundTaskId, { kind: "shell", outputFile });
      return true;
    }
    if (typeof result.taskId === "string" && typeof result.timeoutMs === "number") {
      const started = Date.parse(record.timestamp) || Date.now();
      // A moment's grace past the deadline, for Claude Code's own notice.
      const expires = result.persistent ? undefined : started + result.timeoutMs + 5000;
      this.tasks.set(result.taskId, { kind: "monitor", expires });
      return true;
    }
    if (result.status === "async_launched" && typeof result.agentId === "string") {
      this.tasks.set(result.agentId, { kind: "agent" });
      return true;
    }
    return changed;
  }

  private changed() {
    this.emit("change");
    const checkable = [...this.tasks.values()].some((task) => task.kind !== "agent");
    if (checkable && !this.timer) {
      this.timer = setInterval(() => void this.check(), this.checkInterval);
      this.timer.unref();
    } else if (!checkable && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Ends the shells nothing writes to any more and the monitors past their deadline. */
  private async check() {
    if (this.checking) return;
    this.checking = true;
    try {
      let changed = false;
      for (const [id, task] of this.tasks) {
        if (task.kind === "monitor" && task.expires && Date.now() > task.expires) changed = this.tasks.delete(id);
      }

      const shells = [...this.tasks].filter(([, task]) => task.kind === "shell" && task.outputFile) as [string, { outputFile: string }][];
      if (shells.length > 0) {
        const open = await openFiles(shells.map(([, task]) => task.outputFile));
        if (open) {
          for (const [id, task] of shells) {
            if (!open.has(task.outputFile) && this.tasks.delete(id)) changed = true;
          }
        }
      }
      if (changed) this.changed();
    } finally {
      this.checking = false;
    }
  }
}

/** Which of the files some process has open, or null if `lsof` couldn't say. */
function openFiles(files: string[]): Promise<Set<string> | null> {
  return new Promise((resolve) => {
    execFile("lsof", ["-n", "-F", "n", "--", ...files], { timeout: 5000 }, (error, stdout) => {
      // It exits 1 when some of them aren't open, which is what's asked.
      if (error && error.code !== 1) return resolve(null);
      const open = new Set<string>();
      for (const line of stdout.split("\n")) if (line.startsWith("n")) open.add(realPath(line.slice(1)));
      resolve(new Set(files.filter((file) => open.has(realPath(file)))));
    });
  });
}

/** `/tmp` is `/private/tmp`; either way, the same file. */
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}
