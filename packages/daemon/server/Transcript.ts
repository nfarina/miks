import { EventEmitter } from "events";
import fs from "fs";
import type { ChatEntry } from "../shared/protocol.ts";

/** How often the transcript is checked for more. A stat; it's cheap. */
const POLL_INTERVAL = 250;

/** How one agent's transcript reads: fed its lines in order, it says what the panel shows. */
export type TranscriptFormat = {
  addLine(line: string): void;
  /** The conversation as it stands. */
  entries(): ChatEntry[];
  /** The file started over. */
  clear(): void;
};

/**
 * A session's conversation, read from its agent's transcript (JSONL) and
 * followed as it grows. Emits `entries` with what continues the conversation,
 * and `reset` with all of it when it changed some other way (a rewind, or the
 * file starting over).
 */
export class Transcript extends EventEmitter<{ entries: [entries: ChatEntry[]]; reset: [entries: ChatEntry[]] }> {
  readonly file: string;
  entries: ChatEntry[] = [];
  private readonly format: TranscriptFormat;
  private offset = 0;
  /** A line still being written, at the end of what's been read. */
  private partial = "";
  private reading = false;
  private readAgain = false;
  private closed = false;
  /** Resolves once what's already there has been read. */
  readonly ready: Promise<void>;

  constructor(file: string, format: TranscriptFormat) {
    super();
    this.file = file;
    this.format = format;
    // watchFile, unlike watch, works on a file that doesn't exist yet: a
    // session has a transcript path before it has a message.
    fs.watchFile(file, { interval: POLL_INTERVAL, persistent: false }, this.changed);
    // And again once that's done: the watcher's first look at the file comes
    // in a moment, off this thread, and what's written before it is never a
    // change to it.
    this.ready = this.read().then(() => this.read());
  }

  // Its own listener to remove: Node has one watcher per path, and
  // unwatchFile without one ends every listener on it, the background
  // follower's (BackgroundTasks) on the same transcript included.
  private readonly changed = () => void this.read();

  close() {
    this.closed = true;
    fs.unwatchFile(this.file, this.changed);
    this.removeAllListeners();
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
      } while (this.readAgain && !this.closed);
    } catch {
      // Unreadable for now (permissions, say): the next change tries again.
    } finally {
      this.reading = false;
    }
  }

  private async readMore() {
    let size: number;
    try {
      size = (await fs.promises.stat(this.file)).size;
    } catch {
      return;
    }

    if (size < this.offset) {
      this.entries = [];
      this.format.clear();
      this.offset = 0;
      this.partial = "";
      this.emit("reset", []);
    }
    if (size === this.offset) return;

    // In chunks, so a long transcript never holds up the terminals.
    const stream = fs.createReadStream(this.file, {
      start: this.offset,
      end: size - 1,
      encoding: "utf8",
      highWaterMark: 1 << 20,
    });
    for await (const chunk of stream) {
      if (this.closed) return stream.destroy();
      const lines = (this.partial + chunk).split("\n");
      this.partial = lines.pop()!;
      for (const line of lines) this.format.addLine(line);
    }
    this.offset = size;
    if (this.closed) return;

    const entries = this.format.entries();
    const added = continuation(this.entries, entries);
    this.entries = entries;
    if (added === null) this.emit("reset", entries);
    else if (added.length > 0) this.emit("entries", added);
  }
}

/**
 * What `next` adds to `previous`, if it carries on from it: it holds
 * `previous`'s last entry, with what came before matching. Null if it
 * doesn't (a rewind), for sending all of it again.
 */
function continuation(previous: ChatEntry[], next: ChatEntry[]): ChatEntry[] | null {
  if (previous.length === 0) return next;
  const last = previous[previous.length - 1];
  const at = next.findLastIndex((entry) => entry.id === last.id);
  if (at < 0) return null;
  // Back as far as both go (the oldest may have dropped off either).
  for (let i = 1; i <= Math.min(at, previous.length - 1); i++) {
    if (next[at - i].id !== previous[previous.length - 1 - i].id) return null;
  }
  return next.slice(at + 1);
}
