import { EventEmitter } from "events";
import fs from "fs";
import type { ChatEntry } from "../shared/protocol.ts";

/**
 * How much of a conversation is kept and sent: plenty to scroll back
 * through, while a transcript can run past 100MB (they hold every tool's
 * output, which the panel doesn't show).
 */
const MAX_ENTRIES = 2000;

/** How often the transcript is checked for more. A stat; it's cheap. */
const POLL_INTERVAL = 250;

/** A line of the conversation's tree: what it follows, and what it says, if anything the panel shows. */
type Node = { parent: string | null; boundary: boolean; entries: ChatEntry[] };

/**
 * A Claude Code session's conversation, read from its transcript (JSONL, a
 * line per message, appended as each one is done) and followed as it grows.
 *
 * A transcript is a tree, not a list: each line names the one it follows
 * (`parentUuid`), and rewinding (Esc Esc) carries on from an earlier one,
 * the lines past it staying in the file. So what's shown is the path back
 * from the latest line. Emits `entries` with what continues the path, and
 * `reset` with all of it when the path changed (a rewind, or the file
 * starting over).
 */
export class Transcript extends EventEmitter<{ entries: [entries: ChatEntry[]]; reset: [entries: ChatEntry[]] }> {
  readonly file: string;
  entries: ChatEntry[] = [];
  private readonly nodes = new Map<string, Node>();
  /** Lines in the order written, for crossing a compaction (see `path`). */
  private readonly order: string[] = [];
  private readonly orderIndex = new Map<string, number>();
  /** The conversation's latest line, the end of the path shown. */
  private leaf: string | null = null;
  private offset = 0;
  /** A line still being written, at the end of what's been read. */
  private partial = "";
  private reading = false;
  private readAgain = false;
  private closed = false;
  /** Resolves once what's already there has been read. */
  readonly ready: Promise<void>;

  constructor(file: string) {
    super();
    this.file = file;
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
      this.nodes.clear();
      this.order.length = 0;
      this.orderIndex.clear();
      this.leaf = null;
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
      for (const line of lines) this.addLine(line);
    }
    this.offset = size;
    if (this.closed) return;

    const path = this.path();
    const added = continuation(this.entries, path);
    this.entries = path;
    if (added === null) this.emit("reset", path);
    else if (added.length > 0) this.emit("entries", added);
  }

  /** Every line of the conversation's tree starts with its parent; the rest is bookkeeping. */
  private addLine(line: string) {
    if (!line.startsWith('{"parentUuid"')) return;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    // Subagents' conversations hang off the main one; they're theirs.
    if (typeof record?.uuid !== "string" || record.isSidechain) return;

    const uuid: string = record.uuid;
    this.nodes.set(uuid, {
      parent: typeof record.parentUuid === "string" ? record.parentUuid : null,
      boundary: record.subtype === "compact_boundary",
      entries: parseRecord(record),
    });
    if (!this.orderIndex.has(uuid)) {
      this.orderIndex.set(uuid, this.order.length);
      this.order.push(uuid);
    }
    this.leaf = uuid;
  }

  /**
   * The conversation as it stands: back from the latest line to the start,
   * up to the most there's room for. A compaction starts over with no parent
   * (the one it names isn't in the file), but it's written right after what
   * it compacted, so the line before it carries on.
   */
  private path(): ChatEntry[] {
    const chunks: ChatEntry[][] = [];
    let count = 0;
    let id = this.leaf;
    const seen = new Set<string>();
    while (id && !seen.has(id) && count < MAX_ENTRIES) {
      seen.add(id);
      const node = this.nodes.get(id);
      if (!node) break;
      if (node.entries.length > 0) {
        chunks.push(node.entries);
        count += node.entries.length;
      }
      if (node.parent) id = node.parent;
      else if (node.boundary) id = this.order[(this.orderIndex.get(id) ?? 0) - 1] ?? null;
      else id = null;
    }
    return chunks.reverse().flat().slice(-MAX_ENTRIES);
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

/**
 * What one transcript line says, for the panel: your prompts, Claude's text,
 * and its tool calls. Everything else (thinking, tool output, the
 * bookkeeping lines) is left out, as are subagents' conversations and the
 * messages Claude Code adds itself.
 */
export function parseTranscriptLine(line: string): ChatEntry[] {
  try {
    return parseRecord(JSON.parse(line));
  } catch {
    return [];
  }
}

/** What one parsed transcript line says, for the panel (see parseTranscriptLine). */
function parseRecord(record: any): ChatEntry[] {
  if (!record || record.isSidechain || record.isMeta || record.isCompactSummary) return [];
  if (typeof record.uuid !== "string") return [];

  const id: string = record.uuid;
  const time = Date.parse(record.timestamp) || 0;
  const content = record.message?.content;

  // A message you sent while Claude was working, which it took in mid-turn.
  if (record.type === "attachment") {
    const attachment = record.attachment;
    if (attachment?.type !== "queued_command" || attachment.commandMode !== "prompt") return [];
    if (attachment.origin?.kind !== "human" || typeof attachment.prompt !== "string") return [];
    const prompt = promptText(attachment.prompt);
    return prompt ? [{ id, kind: "prompt", text: prompt, time }] : [];
  }

  if (record.type === "user") {
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((block: any) => block?.type === "text" && typeof block.text === "string")
              .map((block: any) => block.text)
              .join("\n\n")
          : "";
    const prompt = promptText(text);
    return prompt ? [{ id, kind: "prompt", text: prompt, time }] : [];
  }

  if (record.type === "assistant" && Array.isArray(content)) {
    return content.flatMap((block: any, index: number): ChatEntry[] => {
      const blockId = `${id}:${index}`;
      if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
        return [{ id: blockId, kind: "reply", text: block.text, time }];
      }
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ id: blockId, kind: "tool", name: block.name, time, ...describeTool(block.name, block.input) }];
      }
      return [];
    });
  }

  return [];
}

/**
 * A user message as you typed it, or nothing for the ones Claude Code writes
 * (tool results are user messages too, and so are its notes in angle
 * brackets). Slash commands and `!` commands are recorded as markup.
 */
function promptText(text: string): string | null {
  // Pasted text, recorded inside tags of its own.
  text = text.replace(/<\/?pasted_content(?: [^>]*)?>/g, "");

  const command = text.match(/<command-name>([^<]*)<\/command-name>/)?.[1];
  if (command) {
    const args = text.match(/<command-args>([^<]*)<\/command-args>/)?.[1]?.trim();
    return args ? `${command} ${args}` : command;
  }

  const bash = text.match(/^<bash-input>([\s\S]*)<\/bash-input>$/)?.[1];
  if (bash) return `! ${bash}`;

  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("<") || trimmed.startsWith("[Request interrupted")) return null;
  return trimmed;
}

/** How much of a tool's input the details hold. */
const MAX_DETAIL = 4000;

function describeTool(name: string, input: any): { summary: string; detail?: string } {
  const field = (key: string) => (typeof input?.[key] === "string" ? (input[key] as string) : undefined);
  const truncate = (text: string) => (text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "\n…" : text);

  const command = field("command");
  const filePath = field("file_path") ?? field("notebook_path");
  const summary =
    field("description") ??
    command ??
    filePath ??
    field("pattern") ??
    field("url") ??
    field("query") ??
    field("skill") ??
    field("prompt") ??
    "";
  const firstLine = summary.split("\n")[0].slice(0, 200);

  let detail: string | undefined;
  if (command && command !== firstLine) detail = command;
  else if (field("old_string") !== undefined || field("new_string") !== undefined) {
    const lines = (text = "", mark: string) => (text ? text.split("\n").map((line) => mark + line) : []);
    detail = [...lines(field("old_string"), "- "), ...lines(field("new_string"), "+ ")].join("\n");
  } else if (field("content") !== undefined) detail = field("content");
  else if (input && typeof input === "object" && !filePath && Object.keys(input).length > 0) {
    const json = JSON.stringify(input, null, 2);
    if (json !== JSON.stringify({ [Object.keys(input)[0]]: firstLine }, null, 2)) detail = json;
  }

  return { summary: firstLine, ...(detail ? { detail: truncate(detail) } : {}) };
}
