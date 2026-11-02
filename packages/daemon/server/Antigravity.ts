import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { ChatEntry } from "../shared/protocol.ts";
import type { TranscriptFormat } from "./Transcript.ts";

const MAX_ENTRIES = 2000;

/** How much of a tool's input the details hold. */
const MAX_DETAIL = 4000;

/** How far back from a transcript's end a turn's reply is looked for. */
const REPLY_TAIL = 1 << 20;

/** The footer once it's taking prompts, past any trust screen. */
export const AGY_READY = /\? for shortcuts|esc to cancel/;
/** The footer during a turn. */
export const AGY_BUSY = /esc to cancel/;
/** No hook says it's asking you, so its screen does. */
export const AGY_ASKING = /Requesting permission for:/;

const conversations = () => path.join(os.homedir(), ".gemini/antigravity-cli");

/** Where a conversation's transcript goes, whether or not it's there yet. */
export function agyTranscriptPath(id: string, home = conversations()): string {
  return path.join(home, "brain", id, ".system_generated/logs/transcript_full.jsonl");
}

/** Antigravity's payloads don't name their event; what's in them does. */
function agyEvent(payload: any): string | undefined {
  if (typeof payload?.terminationReason === "string") return "Stop";
  if (typeof payload?.invocationNum === "number") return "PreInvocation";
  if (payload?.toolCall) return "PostToolUse";
  if (typeof payload?.conversationId === "string") return "SessionStart";
}

/**
 * Antigravity's hooks in the terms `applyHook` reads. Their names and fields
 * are its own (camelCase), and two things differ: nothing says a prompt was
 * submitted, but `PreInvocation` comes before each model call and only the
 * first of a turn counts from 0; and `Stop` carries no reply.
 */
export function agyHook(payload: any): any {
  const common = { session_id: payload?.conversationId, transcript_path: payload?.transcriptPath };
  switch (agyEvent(payload)) {
    case "SessionStart":
      return { ...common, hook_event_name: "SessionStart" };
    case "PreInvocation":
      return { ...common, hook_event_name: payload.invocationNum === 0 ? "UserPromptSubmit" : "PostToolUse" };
    case "PostToolUse":
      return { ...common, hook_event_name: "PostToolUse" };
    case "Stop":
      // Documented, though Esc in a reply fires no `Stop` at all (`pollAgy`).
      return { ...common, hook_event_name: payload.terminationReason === "USER_CANCELED" ? "Interrupted" : "Stop" };
    default:
      return common;
  }
}

/** A turn's reply, from the end of its transcript, which `Stop` doesn't carry. */
export function agyReply(file: string): string | undefined {
  let text: string;
  try {
    const { size } = fs.statSync(file);
    const length = Math.min(size, REPLY_TAIL);
    const buffer = Buffer.alloc(length);
    const handle = fs.openSync(file, "r");
    try {
      fs.readSync(handle, buffer, 0, length, size - length);
    } finally {
      fs.closeSync(handle);
    }
    text = buffer.toString("utf8");
  } catch {
    return;
  }

  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"PLANNER_RESPONSE"')) continue;
    try {
      const record = JSON.parse(line);
      if (record?.type === "PLANNER_RESPONSE" && typeof record.content === "string" && record.content) return record.content;
    } catch {}
  }
}

/**
 * The conversation an `agy` holds open, from the moment it starts, unlike its
 * hooks: `agy -c` or `--conversation`. One that's new has nothing written yet.
 */
export function findAgyConversation(shellPid: number, home = conversations()): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("pgrep", ["-P", String(shellPid), "-x", "agy"], (_error, pids) => {
      const pid = pids.trim().split("\n")[0];
      if (!pid) return resolve(undefined);
      execFile("lsof", ["-a", "-p", pid, "-Fn"], (_lsofError, stdout) => {
        const id = stdout.match(/presence\/([\w-]+)\.lock/)?.[1];
        resolve(id && fs.existsSync(agyTranscriptPath(id, home)) ? id : undefined);
      });
    });
  });
}

/**
 * An Antigravity transcript: JSONL, a line per step (`step_index`), appended
 * as each is done. Rewinding carries on from an earlier step, writing it again
 * under the same index, so a step at or before the last replaces what's past it.
 */
export class AgyTranscript implements TranscriptFormat {
  private steps: { index: number; entries: ChatEntry[] }[] = [];

  clear() {
    this.steps = [];
  }

  addLine(line: string) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    const index = record?.step_index;
    if (typeof index !== "number") return;

    while ((this.steps.at(-1)?.index ?? -1) >= index) this.steps.pop();
    const entries = parseStep(record);
    if (entries.length > 0) this.steps.push({ index, entries });
  }

  entries(): ChatEntry[] {
    return this.steps.flatMap((step) => step.entries).slice(-MAX_ENTRIES);
  }
}

/** What one step says: your prompts, its text and its tool calls. Tool results are steps too; they're left out. */
export function parseStep(record: any): ChatEntry[] {
  const id = String(record.step_index);
  const time = Date.parse(record.created_at) || 0;

  if (record.type === "USER_INPUT") {
    if (record.source !== "USER_EXPLICIT" || typeof record.content !== "string") return [];
    const text = record.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/)?.[1]?.trim();
    return text ? [{ id, kind: "prompt", text, time }] : [];
  }

  if (record.type !== "PLANNER_RESPONSE") return [];
  const entries: ChatEntry[] = [];
  if (typeof record.content === "string" && record.content.trim()) {
    entries.push({ id: `${id}:text`, kind: "reply", text: record.content, time });
  }
  const calls = Array.isArray(record.tool_calls) ? record.tool_calls : [];
  calls.forEach((call: any, index: number) => {
    if (typeof call?.name !== "string") return;
    entries.push({ id: `${id}:${index}`, kind: "tool", time, ...describeCall(call.name, call.args) });
  });
  return entries;
}

function describeCall(name: string, args: any): { name: string; summary: string; detail?: string } {
  const field = (key: string) => (typeof args?.[key] === "string" ? (args[key] as string) : undefined);
  const command = field("CommandLine");
  const file = field("Path") ?? field("TargetFile") ?? field("AbsolutePath");
  const summary = (field("toolSummary") ?? command ?? file ?? "").split("\n")[0].slice(0, 200);
  const shown = name === "run_command" ? "Bash" : name === "read_file" ? "Read" : name;

  let detail = command;
  if (!detail && !file && args && typeof args === "object" && Object.keys(args).length > 0) {
    detail = JSON.stringify(args, null, 2);
  }
  if (!detail || detail === summary) return { name: shown, summary };
  return { name: shown, summary, detail: detail.length > MAX_DETAIL ? detail.slice(0, MAX_DETAIL) + "\n…" : detail };
}
