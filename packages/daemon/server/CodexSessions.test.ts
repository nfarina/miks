import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { findCodexSession } from "./CodexSessions.ts";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks-codex-sessions-"));
  const lines = [
    { id: "old", thread_name: "Fix the bug" },
    { id: "abc-1", thread_name: "Other" },
    { id: "abc-2", thread_name: "Fix the bug" },
  ];
  fs.writeFileSync(path.join(home, "session_index.jsonl"), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  fs.mkdirSync(path.join(home, "sessions/2026/11/01"), { recursive: true });
  fs.writeFileSync(path.join(home, "sessions/2026/11/01/rollout-2026-11-01T13-21-04-abc-2.jsonl"), "");
});

afterEach(() => fs.rmSync(home, { recursive: true }));

test("a title's thread is the latest of that name, with its rollout", () => {
  const session = { id: "abc-2", transcriptPath: path.join(home, "sessions/2026/11/01/rollout-2026-11-01T13-21-04-abc-2.jsonl") };
  expect(findCodexSession("Fix the bug | repo", home)).toEqual(session);
  expect(findCodexSession("⠋ Fix the bug | repo", home)).toEqual(session);
});

test("a compressed rollout still names the session", () => {
  expect(findCodexSession("Other | repo", home)).toEqual({ id: "abc-1", transcriptPath: undefined });
});

test("no thread in the title, or no such thread, is nothing", () => {
  expect(findCodexSession("repo", home)).toBeUndefined();
  expect(findCodexSession("Never heard of it | repo", home)).toBeUndefined();
});
