import fs from "fs";
import os from "os";
import path from "path";
import { expect, test } from "vitest";
import { CodexTranscript } from "./CodexTranscript.ts";
import { Transcript } from "./Transcript.ts";

const line = (payload: object) =>
  JSON.stringify({ timestamp: "2026-11-01T21:21:56.187Z", ordinal: 1, type: "event_msg", payload });

const item = (turn: string, fields: object) => line({ type: "item_completed", turn_id: turn, item: fields });

const entriesOf = (...lines: string[]) => {
  const transcript = new CodexTranscript();
  for (const each of lines) transcript.addLine(each);
  return transcript.entries();
};

test("prompts, replies and tools come through, in the rollout's words", () => {
  const entries = entriesOf(
    item("t1", { type: "UserMessage", id: "u", content: [{ type: "text", text: "Fix it", text_elements: [] }] }),
    item("t1", { type: "Reasoning", id: "r", summary_text: [] }),
    item("t1", { type: "AgentMessage", id: "a", content: [{ type: "Text", text: "On it" }], phase: "commentary" }),
    item("t1", {
      type: "CommandExecution",
      id: "c",
      command: ["/bin/zsh", "-lc", "yarn test"],
      parsed_cmd: [{ type: "unknown", cmd: "yarn test" }],
    }),
    item("t1", {
      type: "CommandExecution",
      id: "c2",
      command: ["/bin/zsh", "-lc", "cat a.md"],
      parsed_cmd: [{ type: "read", cmd: "cat a.md", name: "a.md", path: "/x/a.md" }],
    }),
    item("t1", { type: "FileChange", id: "f", changes: { "/x/a.md": { type: "update", unified_diff: "-a\n+b" } } }),
    item("t1", { type: "FileChange", id: "f2", changes: { "/x/b.md": { type: "add", content: "hello" } } }),
    item("t1", { type: "Extension", kind: "web.search", id: "w", query: "miks" }),
  );

  const time = Date.parse("2026-11-01T21:21:56.187Z");
  expect(entries).toEqual([
    { id: "u", kind: "prompt", text: "Fix it", time },
    { id: "a", kind: "reply", text: "On it", time },
    { id: "c", kind: "tool", name: "Bash", summary: "yarn test", time },
    { id: "c2", kind: "tool", name: "Read", summary: "/x/a.md", detail: "cat a.md", time },
    { id: "f", kind: "tool", name: "Edit", summary: "/x/a.md", detail: "-a\n+b", time },
    { id: "f2", kind: "tool", name: "Write", summary: "/x/b.md", detail: "hello", time },
    { id: "w", kind: "tool", name: "Web search", summary: "miks", time },
  ]);
});

test("lines that aren't events are skipped, as are broken and repeated ones", () => {
  const prompt = item("t1", { type: "UserMessage", id: "u", content: [{ type: "text", text: "Hi" }] });
  const entries = entriesOf(
    prompt,
    prompt,
    '{"timestamp":"x","type":"event_msg","payload":',
    JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } }),
    line({ type: "token_count" }),
  );
  expect(entries.map((entry) => entry.id)).toEqual(["u"]);
});

test("rolling back drops whole turns from the end", () => {
  const say = (turn: string) => item(turn, { type: "UserMessage", id: turn, content: [{ type: "text", text: turn }] });
  const entries = entriesOf(say("t1"), say("t2"), say("t3"), line({ type: "thread_rolled_back", num_turns: 2 }), say("t4"));
  expect(entries.map((entry) => entry.id)).toEqual(["t1", "t4"]);
});

test("a rollback resets what's being followed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks-codex-"));
  const file = path.join(dir, "rollout.jsonl");
  const say = (turn: string) => item(turn, { type: "UserMessage", id: turn, content: [{ type: "text", text: turn }] });
  fs.writeFileSync(file, say("t1") + "\n" + say("t2") + "\n");

  const transcript = new Transcript(file, new CodexTranscript());
  await transcript.ready;
  expect(transcript.entries.map((entry) => entry.id)).toEqual(["t1", "t2"]);

  const reset = new Promise<string[]>((resolve) =>
    transcript.on("reset", (entries) => resolve(entries.map((entry) => entry.id))),
  );
  fs.appendFileSync(file, line({ type: "thread_rolled_back", num_turns: 1 }) + "\n");
  expect(await reset).toEqual(["t1"]);

  transcript.close();
  fs.rmSync(dir, { recursive: true });
});
