import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "vitest";
import { GrokTranscript, grokHook, grokTranscriptPath } from "./Grok.ts";

const entriesOf = (...records: object[]) => {
  const transcript = new GrokTranscript();
  for (const each of records) transcript.addLine(JSON.stringify(each));
  return transcript.entries().map(({ time, ...entry }) => entry);
};

const prompt = (index: number, text: string) => ({
  type: "user",
  content: [{ type: "text", text: `<user_query>\n${text}\n</user_query>` }],
  prompt_index: index,
});

test("prompts, replies and tools come through, and context grok adds doesn't", () => {
  const entries = entriesOf(
    { type: "system", content: "You are Grok" },
    { type: "user", content: [{ type: "text", text: "<user_info>\nOS Version: macos\n</user_info>" }] },
    prompt(0, "Fix it"),
    { type: "user", content: [{ type: "text", text: "<system-reminder>skills</system-reminder>" }], synthetic_reason: "system_reminder" },
    { type: "reasoning", id: "r", summary: [] },
    {
      type: "assistant",
      content: "On it",
      tool_calls: [
        { id: "c1", name: "run_terminal_command", arguments: '{"command":"yarn test","description":"Run tests"}' },
        { id: "c2", name: "read_file", arguments: '{"target_file":"/x/a.md","limit":180}' },
        { id: "c3", name: "search_replace", arguments: '{"file_path":"/x/a.md","old_string":"a\\nb","new_string":"c"}' },
      ],
    },
    { type: "tool_result", tool_call_id: "c1", content: "exit: 0" },
    { type: "assistant", content: "Done." },
  );
  expect(entries).toEqual([
    { id: "2", kind: "prompt", text: "Fix it" },
    { id: "5", kind: "reply", text: "On it" },
    { id: "5:0", kind: "tool", name: "Bash", summary: "yarn test" },
    { id: "5:1", kind: "tool", name: "Read", summary: "/x/a.md" },
    { id: "5:2", kind: "tool", name: "Edit", summary: "/x/a.md", detail: "-a\n-b\n+c" },
    { id: "7", kind: "reply", text: "Done." },
  ]);
});

test("a prompt at or before the last replaces what's past it", () => {
  const entries = entriesOf(
    prompt(0, "one"),
    { type: "assistant", content: "1" },
    prompt(1, "two"),
    { type: "assistant", content: "2" },
    prompt(1, "two again"),
  );
  expect(entries.map((entry) => (entry.kind === "tool" ? entry.name : entry.text))).toEqual(["one", "1", "two again"]);
});

test("hooks come out in Claude Code's terms", () => {
  const common = { session_id: "s", transcript_path: "/g/s/updates.jsonl" };
  const event = (payload: object) => grokHook({ ...common, ...payload })?.hook_event_name;
  expect(grokHook({ ...common, hook_event_name: "SessionStart" }).transcript_path).toBe("/g/s/chat_history.jsonl");
  expect(event({ hook_event_name: "StopCancelled", reason: "user_interrupt" })).toBe("Interrupted");
  expect(event({ hook_event_name: "Stop", reason: "end_turn" })).toBe("Stop");
  expect(event({ hook_event_name: "Stop", reason: "shutdown" })).toBeUndefined();
  expect(grokHook({ ...common, hook_event_name: "StopFailure", lastAssistantMessage: "Rate limited" })).toMatchObject({
    hook_event_name: "Stop",
    last_assistant_message: "Rate limited",
  });
  expect(event({ hook_event_name: "Notification", notificationType: "task_complete" })).toBeUndefined();
  expect(event({ hook_event_name: "Notification", notificationType: "permission_prompt" })).toBe("Notification");
  expect(grokHook({ ...common, hook_event_name: "PostToolUse", subagentType: "explore" })).toBeUndefined();
});

test("without a path from the hook, the transcript's found where grok keeps the session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "miks-grok-"));
  const cwd = "/Users/me/Code/my project";
  expect(grokTranscriptPath("a", undefined, cwd, home)).toBe(path.join(home, "%2FUsers%2Fme%2FCode%2Fmy%20project/a/chat_history.jsonl"));
  // Started somewhere else: found by its ID.
  fs.mkdirSync(path.join(home, "elsewhere/b"), { recursive: true });
  expect(grokTranscriptPath("b", undefined, cwd, home)).toBe(path.join(home, "elsewhere/b/chat_history.jsonl"));
  fs.rmSync(home, { recursive: true });
});
