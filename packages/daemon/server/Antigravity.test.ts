import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "vitest";
import { AGY_ASKING, AGY_BUSY, AGY_READY, AgyTranscript, agyHook, agyReply } from "./Antigravity.ts";

const step = (fields: object) => JSON.stringify({ created_at: "2026-11-01T23:40:50Z", status: "DONE", ...fields });
const prompt = (index: number, text: string) =>
  step({
    step_index: index,
    source: "USER_EXPLICIT",
    type: "USER_INPUT",
    content: `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time\n</ADDITIONAL_METADATA>`,
  });
const reply = (index: number, text: string) => step({ step_index: index, source: "MODEL", type: "PLANNER_RESPONSE", content: text });

const entriesOf = (...lines: string[]) => {
  const transcript = new AgyTranscript();
  for (const line of lines) transcript.addLine(line);
  return transcript.entries();
};

test("prompts, replies and tool calls come through; tool results and metadata don't", () => {
  const time = Date.parse("2026-11-01T23:40:50Z");
  const call = {
    step_index: 1,
    source: "MODEL",
    type: "PLANNER_RESPONSE",
    content: "Looking",
    thinking: "Hmm",
    tool_calls: [
      { name: "read_file", args: { Path: "/x/a.md" } },
      { name: "run_command", args: { CommandLine: "yarn test\necho done", toolSummary: "Run the tests" } },
    ],
  };
  expect(
    entriesOf(prompt(0, "Fix it"), step(call), step({ step_index: 2, source: "MODEL", type: "GENERIC", content: "Exit code 0" })),
  ).toEqual([
    { id: "0", kind: "prompt", text: "Fix it", time },
    { id: "1:text", kind: "reply", text: "Looking", time },
    { id: "1:0", kind: "tool", name: "Read", summary: "/x/a.md", time },
    { id: "1:1", kind: "tool", name: "Bash", summary: "Run the tests", detail: "yarn test\necho done", time },
  ]);
});

test("a step written again under its index replaces it and what came after", () => {
  const entries = entriesOf(prompt(0, "a"), reply(1, "A"), prompt(2, "b"), reply(3, "B"), prompt(2, "again"), reply(3, "C"));
  expect(entries.map((entry) => (entry.kind === "tool" ? entry.name : entry.text))).toEqual(["a", "A", "again", "C"]);
});

test("the same step twice shows once", () => {
  expect(entriesOf(prompt(4, "essay"), prompt(4, "essay")).length).toBe(1);
});

test("hooks come out in applyHook's terms, by what's in their payloads", () => {
  const common = { conversationId: "c1", transcriptPath: "/t.jsonl", lastUserInput: "hi" };
  const session = { session_id: "c1", transcript_path: "/t.jsonl" };
  expect(agyHook(common)).toEqual({ ...session, hook_event_name: "SessionStart" });
  expect(agyHook({ ...common, invocationNum: 0 })).toEqual({ ...session, hook_event_name: "UserPromptSubmit" });
  expect(agyHook({ ...common, invocationNum: 1 })).toEqual({ ...session, hook_event_name: "PostToolUse" });
  expect(agyHook({ ...common, stepIdx: 2, toolCall: { name: "run_command" } })).toEqual({ ...session, hook_event_name: "PostToolUse" });
  expect(agyHook({ ...common, terminationReason: "NO_TOOL_CALL" })).toEqual({ ...session, hook_event_name: "Stop" });
  expect(agyHook({ ...common, terminationReason: "USER_CANCELED" })).toEqual({ ...session, hook_event_name: "Interrupted" });
});

test("a turn's reply is the last response with words in it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks-agy-"));
  const file = path.join(dir, "transcript_full.jsonl");
  fs.writeFileSync(file, [prompt(0, "a"), reply(1, "first"), reply(2, "last"), reply(3, "")].join("\n") + "\n");
  expect(agyReply(file)).toBe("last");
  expect(agyReply(path.join(dir, "missing"))).toBeUndefined();
  fs.rmSync(dir, { recursive: true });
});

test("its footers say what they should", () => {
  expect(AGY_READY.test("? for shortcuts   Gemini 4 Argon")).toBe(true);
  expect(AGY_READY.test("Trust this folder?")).toBe(false);
  expect(AGY_BUSY.test("esc to cancel")).toBe(true);
  expect(AGY_ASKING.test("Requesting permission for:\n sleep 6")).toBe(true);
});
