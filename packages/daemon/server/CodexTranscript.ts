import type { ChatEntry } from "../shared/protocol.ts";
import type { TranscriptFormat } from "./Transcript.ts";

const MAX_ENTRIES = 2000;

/** How much of a tool's input the details hold. */
const MAX_DETAIL = 4000;

/** Past this a line can't still be saying what it is. */
const LINE_START = 120;

/**
 * A Codex rollout: JSONL, each thing said or done an `event_msg`
 * `item_completed` line once it's finished. The same conversation is in there
 * again as `response_item` lines, but those are what the model saw: a command
 * can be a script it ran, where the item has the command itself. Not a
 * documented format, so anything unknown is left out.
 *
 * Rolling back drops whole turns from the end without touching the lines
 * already written (`thread_rolled_back`), so entries are kept by turn.
 */
export class CodexTranscript implements TranscriptFormat {
  private turns: { id: string; entries: ChatEntry[] }[] = [];
  private readonly seen = new Set<string>();

  clear() {
    this.turns = [];
    this.seen.clear();
  }

  addLine(line: string) {
    if (!line.slice(0, LINE_START).includes('"type":"event_msg"')) return;

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    const payload = record?.payload;
    if (payload?.type === "thread_rolled_back") {
      const count = typeof payload.num_turns === "number" ? payload.num_turns : 0;
      if (count > 0) this.turns.splice(-count);
      return;
    }
    if (payload?.type !== "item_completed" || typeof payload.turn_id !== "string") return;

    const item = payload.item;
    if (typeof item?.id !== "string" || this.seen.has(item.id)) return;
    this.seen.add(item.id);

    const entries = parseItem(item, Date.parse(record.timestamp) || 0);
    if (entries.length === 0) return;
    const last = this.turns.at(-1);
    if (last && last.id === payload.turn_id) last.entries.push(...entries);
    else this.turns.push({ id: payload.turn_id, entries });
  }

  entries(): ChatEntry[] {
    return this.turns.flatMap((turn) => turn.entries).slice(-MAX_ENTRIES);
  }
}

/** What one `item_completed` says, for the panel. */
export function parseItem(item: any, time: number): ChatEntry[] {
  const id: string = item.id;
  const tool = (name: string, summary: string, detail?: string): ChatEntry[] => [
    { id, kind: "tool", name, time, summary: summary.split("\n")[0].slice(0, 200), ...(detail ? { detail: truncate(detail) } : {}) },
  ];

  switch (item.type) {
    case "UserMessage": {
      const text = texts(item.content);
      return text ? [{ id, kind: "prompt", text, time }] : [];
    }
    case "AgentMessage": {
      const text = texts(item.content);
      return text ? [{ id, kind: "reply", text, time }] : [];
    }
    case "CommandExecution": {
      const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : [];
      const command = (Array.isArray(item.command) ? item.command.at(-1) : undefined) ?? parsed[0]?.cmd ?? "";
      if (typeof command !== "string") return [];
      // What it comes to when it's a single thing, as Claude Code's own tools say it.
      if (parsed.length === 1 && parsed[0].type === "read" && parsed[0].path) return tool("Read", parsed[0].path, command);
      if (parsed.length === 1 && parsed[0].type === "search") return tool("Search", parsed[0].cmd ?? command, command);
      return tool("Bash", command, command.includes("\n") ? command : undefined);
    }
    case "FileChange": {
      const changes = Object.entries<any>(item.changes ?? {});
      if (changes.length === 0) return [];
      const adding = changes.every(([, change]) => change?.type === "add");
      const summary = changes.length === 1 ? changes[0][0] : `${changes.length} files`;
      return tool(adding ? "Write" : "Edit", summary, changes.map(([file, change]) => describeChange(file, change, changes.length > 1)).join("\n"));
    }
    case "McpToolCall":
      return typeof item.tool === "string" ? tool(item.tool, firstValue(item.arguments), json(item.arguments)) : [];
    case "ImageView":
      return tool("View image", String(item.path ?? "").replace(/^file:\/\//, ""));
    case "Extension":
      if (item.kind === "web.search") return tool("Web search", String(item.query ?? ""));
      return typeof item.kind === "string" ? tool(item.kind, "") : [];
    default:
      return [];
  }
}

function texts(content: any): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block?.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function describeChange(file: string, change: any, named: boolean): string {
  const body =
    change?.type === "add"
      ? (change.content ?? "")
      : typeof change?.unified_diff === "string"
        ? change.unified_diff
        : "";
  return named ? `${file}\n${body}` : body;
}

function firstValue(input: any): string {
  if (!input || typeof input !== "object") return "";
  const value = Object.values(input).find((candidate) => typeof candidate === "string");
  return typeof value === "string" ? value : "";
}

function json(input: any): string | undefined {
  if (!input || typeof input !== "object" || Object.keys(input).length === 0) return;
  return JSON.stringify(input, null, 2);
}

function truncate(text: string): string {
  return text.length > MAX_DETAIL ? text.slice(0, MAX_DETAIL) + "\n…" : text;
}
