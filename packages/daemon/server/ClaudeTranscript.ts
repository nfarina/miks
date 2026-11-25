import type { AskQuestion, ChatEntry } from "../shared/protocol.ts";
import type { TranscriptFormat } from "./Transcript.ts";

/**
 * How much of a conversation is kept and sent: plenty to scroll back
 * through, while a transcript can run past 100MB (they hold every tool's
 * output, which the panel doesn't show).
 */
const MAX_ENTRIES = 2000;

/** A line of the conversation's tree: what it follows, and what it says, if anything the panel shows. */
type Node = { parent: string | null; boundary: boolean; entries: ChatEntry[] };

/**
 * A Claude Code transcript: JSONL, a line per message, appended as each one
 * is done.
 *
 * It's a tree, not a list: each line names the one it follows (`parentUuid`),
 * and rewinding (Esc Esc) carries on from an earlier one, the lines past it
 * staying in the file. So what's shown is the path back from the latest line.
 */
export class ClaudeTranscript implements TranscriptFormat {
  private readonly nodes = new Map<string, Node>();
  /** Lines in the order written, for crossing a compaction (see `entries`). */
  private readonly order: string[] = [];
  private readonly orderIndex = new Map<string, number>();
  /** The conversation's latest line, the end of the path shown. */
  private leaf: string | null = null;

  clear() {
    this.nodes.clear();
    this.order.length = 0;
    this.orderIndex.clear();
    this.leaf = null;
  }

  /** Every line of the conversation's tree starts with its parent; the rest is bookkeeping. */
  addLine(line: string) {
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
  entries(): ChatEntry[] {
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
    const answered = askAnswers(record);
    if (answered) return [{ id, kind: "tool", name: "AskUserQuestion", summary: "Answered", time, answered }];
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
      if (block?.type === "tool_use" && block.name === "AskUserQuestion" && typeof block.id === "string") {
        const questions = askQuestions(block.input?.questions);
        if (questions) {
          const summary = questions[0].question.split("\n")[0].slice(0, 200);
          return [{ id: blockId, kind: "tool", name: block.name, time, summary, ask: { toolUseId: block.id, questions } }];
        }
      }
      if (block?.type === "tool_use" && typeof block.name === "string") {
        return [{ id: blockId, kind: "tool", name: block.name, time, ...describeTool(block.name, block.input) }];
      }
      return [];
    });
  }

  return [];
}

/** An AskUserQuestion's questions, if they're as its tool takes them. */
function askQuestions(input: unknown): AskQuestion[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const questions: AskQuestion[] = [];
  for (const each of input) {
    if (typeof each?.question !== "string" || !Array.isArray(each.options)) return null;
    const options = each.options
      .filter((option: any) => typeof option?.label === "string")
      .map((option: any) => ({
        label: option.label as string,
        ...(typeof option.description === "string" && { description: option.description as string }),
        ...(typeof option.preview === "string" && { preview: option.preview as string }),
      }));
    questions.push({
      question: each.question,
      ...(typeof each.header === "string" && { header: each.header }),
      ...(each.multiSelect === true && { multiSelect: true }),
      options,
    });
  }
  return questions;
}

/**
 * The answers in an AskUserQuestion's result: `toolUseResult` holds them as
 * the tool returned them, `answers` by question, with `annotations` for
 * notes. Answered nothing (Esc), it's an error result, and so no answers.
 */
function askAnswers(record: any) {
  const result = record.toolUseResult;
  const block = Array.isArray(record.message?.content)
    ? record.message.content.find((each: any) => each?.type === "tool_result")
    : undefined;
  if (typeof block?.tool_use_id !== "string" || !Array.isArray(result?.questions)) return null;
  if (!result.answers || typeof result.answers !== "object") return null;

  const answers: Record<string, string | string[]> = {};
  for (const [question, answer] of Object.entries(result.answers)) {
    if (typeof answer === "string" || (Array.isArray(answer) && answer.every((each) => typeof each === "string"))) {
      answers[question] = answer as string | string[];
    }
  }
  const notes: Record<string, string> = {};
  for (const [question, annotation] of Object.entries(result.annotations ?? {})) {
    const note = (annotation as any)?.notes;
    if (typeof note === "string" && note) notes[question] = note;
  }
  return { toolUseId: block.tool_use_id as string, answers, ...(Object.keys(notes).length > 0 && { notes }) };
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
