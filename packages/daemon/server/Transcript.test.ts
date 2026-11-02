import { expect, test } from "vitest";
import { ClaudeTranscript, parseTranscriptLine } from "./ClaudeTranscript.ts";

const line = (record: object) => JSON.stringify({ uuid: "u1", timestamp: "2026-10-20T12:00:00.000Z", ...record });

test("prompts, replies and tool calls come through; the rest of the transcript doesn't", () => {
  expect(parseTranscriptLine(line({ type: "user", message: { role: "user", content: "Fix the **bug**" } }))).toEqual([
    { id: "u1", kind: "prompt", text: "Fix the **bug**", time: Date.parse("2026-10-20T12:00:00.000Z") },
  ]);

  const assistant = parseTranscriptLine(
    line({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Hmm." },
          { type: "text", text: "Here's the fix:\n\n- one" },
          { type: "tool_use", name: "Bash", input: { command: "yarn test", description: "Run the tests" } },
        ],
      },
    }),
  );
  expect(assistant.map((entry) => entry.kind)).toEqual(["reply", "tool"]);
  expect(assistant[0]).toMatchObject({ id: "u1:1", text: "Here's the fix:\n\n- one" });
  expect(assistant[1]).toMatchObject({ id: "u1:2", name: "Bash", summary: "Run the tests", detail: "yarn test" });

  // Tool results, Claude Code's own notes, subagents, and bookkeeping.
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", content: "lots of output" }] } };
  expect(parseTranscriptLine(line(toolResult))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "user", isMeta: true, message: { content: "Caveat" } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "user", message: { content: "<local-command-stdout>hi</local-command-stdout>" } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "Sub" }] } }))).toEqual([]);
  expect(parseTranscriptLine(line({ type: "summary", summary: "x" }))).toEqual([]);
  expect(parseTranscriptLine("not json")).toEqual([]);
});

test("slash commands and ! commands read as you typed them", () => {
  const command = "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>";
  expect(parseTranscriptLine(line({ type: "user", message: { content: command } }))[0]).toMatchObject({ text: "/model opus" });
  expect(parseTranscriptLine(line({ type: "user", message: { content: "<bash-input>ls</bash-input>" } }))[0]).toMatchObject({
    text: "! ls",
  });
});

test("an edit's details read like a diff", () => {
  const [edit] = parseTranscriptLine(
    line({
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "/a.ts", old_string: "a\nb", new_string: "c" } }] },
    }),
  );
  expect(edit).toMatchObject({ summary: "/a.ts", detail: "- a\n- b\n+ c" });
});

test("pasted messages, and ones sent while Claude was working, are prompts too", () => {
  const pasted = '\n\n<pasted_content id="a08f">\nSome things:\n\n- one\n</pasted_content id="a08f">\n';
  expect(parseTranscriptLine(line({ type: "user", message: { content: pasted } }))[0]).toMatchObject({
    kind: "prompt",
    text: "Some things:\n\n- one",
  });

  const queued = { type: "queued_command", prompt: "Also this", commandMode: "prompt", origin: { kind: "human" } };
  expect(parseTranscriptLine(line({ type: "attachment", attachment: queued }))).toEqual([
    { id: "u1", kind: "prompt", text: "Also this", time: Date.parse("2026-10-20T12:00:00.000Z") },
  ]);
  const fromAgent = { ...queued, origin: { kind: "task-notification" } };
  expect(parseTranscriptLine(line({ type: "attachment", attachment: fromAgent }))).toEqual([]);
});

test("a rewound conversation shows the path it took, and a compaction carries on from before it", async () => {
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const { Transcript } = await import("./Transcript.ts");
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "miks transcript-")), "t.jsonl");
  const say = (uuid: string, parentUuid: string | null, type: "user" | "assistant", text: string, extra = {}) =>
    JSON.stringify({ parentUuid, ...extra, type, uuid, timestamp: "2026-10-20T12:00:00.000Z", message: { role: type, content: type === "user" ? text : [{ type: "text", text }] } });
  fs.writeFileSync(
    file,
    [
      say("a", null, "user", "One"),
      say("b", "a", "assistant", "Two"),
      // Compacted: no parent (its logical one isn't a line), right after "Two".
      JSON.stringify({ parentUuid: null, logicalParentUuid: "elsewhere", type: "system", subtype: "compact_boundary", uuid: "c" }),
      say("d", "c", "user", "Three"),
      say("e", "d", "assistant", "Four"),
      say("f", "e", "user", "Rewound past"),
      say("g", "f", "assistant", "Gone"),
      // Rewound to after "Four".
      say("h", "e", "user", "Instead"),
      // Bookkeeping lines don't count.
      JSON.stringify({ type: "last-prompt", lastPrompt: "Instead", leafUuid: "h" }),
      "",
    ].join("\n"),
  );

  const transcript = new Transcript(file, new ClaudeTranscript());
  await transcript.ready;
  transcript.close();
  expect(transcript.entries.map((entry) => ("text" in entry ? entry.text : ""))).toEqual(["One", "Two", "Three", "Four", "Instead"]);
});
