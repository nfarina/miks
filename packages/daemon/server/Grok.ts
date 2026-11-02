import fs from "fs";
import os from "os";
import path from "path";
import type { ChatEntry } from "../shared/protocol.ts";
import type { TranscriptFormat } from "./Transcript.ts";

const MAX_ENTRIES = 2000;

/** How much of a tool's input the details hold. */
const MAX_DETAIL = 4000;

const TRANSCRIPT = "chat_history.jsonl";

const sessions = () => path.join(os.homedir(), ".grok/sessions");

/**
 * Where a session's transcript is. Hooks carry `transcript_path`, but it's the
 * session's `updates.jsonl`, and the first few (`SessionStart`,
 * `UserPromptSubmit`) carry none, so then it's from the folder grok keeps
 * sessions in, named for where it was started.
 */
export function grokTranscriptPath(id: string, given?: string, cwd?: string, home = sessions()): string | undefined {
  if (given) return path.join(path.dirname(given), TRANSCRIPT);
  if (cwd) {
    const folder = path.join(home, encodeURIComponent(cwd), id);
    if (fs.existsSync(folder)) return path.join(folder, TRANSCRIPT);
  }
  try {
    for (const each of fs.readdirSync(home)) {
      const folder = path.join(home, each, id);
      if (fs.existsSync(folder)) return path.join(folder, TRANSCRIPT);
    }
  } catch {}
  // Not written yet: a new session's folder comes with its first prompt.
  if (cwd) return path.join(home, encodeURIComponent(cwd), id, TRANSCRIPT);
}

/**
 * grok's hooks in the terms `applyHook` reads. They're Claude Code's, its
 * snake_case fields included, beside grok's own camelCase ones, with a few
 * differences: an interrupt is `StopCancelled`; an API error ending a turn
 * is `StopFailure`, its error the reply; quitting fires another `Stop`
 * (`reason` "shutdown"), which isn't a turn; and only `permission_prompt`
 * among notifications is asking you. A subagent's events aren't the tab's.
 */
export function grokHook(payload: any): any {
  if (payload?.subagentType || payload?.subagent_type) return;
  const sessionId = payload?.session_id ?? payload?.sessionId;
  const transcriptPath =
    typeof sessionId === "string"
      ? grokTranscriptPath(sessionId, payload?.transcript_path ?? payload?.transcriptPath, payload?.cwd)
      : undefined;
  const common = { session_id: sessionId, transcript_path: transcriptPath };
  const message = payload?.last_assistant_message ?? payload?.lastAssistantMessage;

  switch (payload?.hook_event_name) {
    case "SessionStart":
    case "UserPromptSubmit":
    case "PostToolUse":
    case "SessionEnd":
      return { ...common, hook_event_name: payload.hook_event_name };
    case "PostToolUseFailure":
      return { ...common, hook_event_name: "PostToolUse" };
    case "Stop":
      if (payload.reason && payload.reason !== "end_turn") return common;
      return { ...common, hook_event_name: "Stop", last_assistant_message: message };
    case "StopFailure":
      return { ...common, hook_event_name: "Stop", last_assistant_message: message };
    case "StopCancelled":
      return { ...common, hook_event_name: "Interrupted" };
    case "Notification": {
      const type = payload.notification_type ?? payload.notificationType;
      if (type !== "permission_prompt" && type !== "idle_prompt") return common;
      return { ...common, hook_event_name: "Notification", notification_type: type, message: payload.message };
    }
    default:
      return common;
  }
}

/**
 * A grok transcript (`chat_history.jsonl`): JSONL, a line per message, in the
 * shape of a chat API's: `user` (yours carry a `prompt_index`; context it
 * adds has none), `assistant` with `content` and `tool_calls`, `tool_result`.
 * Entries are kept by prompt, so one at or before the last (a rewind, if it
 * writes again rather than truncating) replaces what's past it.
 */
export class GrokTranscript implements TranscriptFormat {
  private prompts: { index: number; entries: ChatEntry[] }[] = [];
  private lines = 0;

  clear() {
    this.prompts = [];
    this.lines = 0;
  }

  addLine(line: string) {
    const number = this.lines++;
    // Its lines have no times; the panel matches what you sent by when.
    const time = Date.now();
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }

    if (record?.type === "user") {
      const index = record.prompt_index;
      if (typeof index !== "number") return;
      while ((this.prompts.at(-1)?.index ?? -1) >= index) this.prompts.pop();
      const text = promptText(record.content);
      this.prompts.push({ index, entries: text ? [{ id: `${number}`, kind: "prompt", text, time }] : [] });
      return;
    }

    if (record?.type !== "assistant") return;
    const entries: ChatEntry[] = [];
    const text = texts(record.content);
    if (text) entries.push({ id: `${number}`, kind: "reply", text, time });
    const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
    calls.forEach((call: any, index: number) => {
      if (typeof call?.name !== "string") return;
      entries.push({ id: `${number}:${index}`, kind: "tool", time, ...describeCall(call.name, call.arguments) });
    });
    if (entries.length === 0) return;
    // Anything before the first prompt (a resumed session's, say) goes with it.
    const last = this.prompts.at(-1) ?? this.prompts[this.prompts.push({ index: -1, entries: [] }) - 1];
    last.entries.push(...entries);
  }

  entries(): ChatEntry[] {
    return this.prompts.flatMap((prompt) => prompt.entries).slice(-MAX_ENTRIES);
  }
}

function diff(old: string, next: string): string {
  const lines = (text: string, mark: string) => (text ? text.split("\n").map((line) => mark + line) : []);
  return [...lines(old, "-"), ...lines(next, "+")].join("\n");
}

function texts(content: any): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => typeof block?.text === "string")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

/** What you typed, from inside the tags grok wraps it in. */
function promptText(content: any): string {
  const text = texts(content);
  return (text.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? text).trim();
}

function describeCall(name: string, json: any): { name: string; summary: string; detail?: string } {
  let args: any = json;
  if (typeof json === "string") {
    try {
      args = JSON.parse(json);
    } catch {
      args = {};
    }
  }
  const field = (key: string) => (typeof args?.[key] === "string" ? (args[key] as string) : undefined);

  const done = (shown: string, summary = "", detail?: string) => ({
    name: shown,
    summary: summary.split("\n")[0].slice(0, 200),
    ...(detail && detail !== summary ? { detail: detail.length > MAX_DETAIL ? detail.slice(0, MAX_DETAIL) + "\n…" : detail } : {}),
  });

  switch (name) {
    case "run_terminal_command": {
      const command = field("command") ?? "";
      return done("Bash", command, command.includes("\n") ? command : undefined);
    }
    case "read_file":
      return done("Read", field("target_file"));
    case "list_dir":
      return done("List", field("target_directory"));
    case "grep":
      return done("Search", field("pattern"));
    case "search_replace":
      return done(
        "Edit",
        field("file_path"),
        field("old_string") !== undefined ? diff(field("old_string")!, field("new_string") ?? "") : undefined,
      );
    case "write":
    case "write_file":
      return done("Write", field("file_path") ?? field("target_file"), field("content") ?? field("contents"));
    case "web_fetch":
      return done("Fetch", field("url"));
    case "web_search":
      return done("Web search", field("query"));
    default: {
      const first = Object.values(args ?? {}).find((value) => typeof value === "string");
      const detail = args && typeof args === "object" && Object.keys(args).length > 0 ? JSON.stringify(args, null, 2) : undefined;
      return done(name, typeof first === "string" ? first : "", detail);
    }
  }
}
