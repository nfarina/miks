import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// Several waits in a row, each on a 250ms poll: more than 5s, on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });
import { BackgroundTasks } from "./BackgroundTasks.ts";

let dir: string;
let transcript: string;
let tasks: BackgroundTasks;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "miks background-"));
  transcript = path.join(dir, "session.jsonl");
  // What an earlier Claude Code process started, which isn't running now.
  fs.writeFileSync(transcript, started("old", { backgroundTaskId: "old" }, "/nowhere/old.output"));
  tasks = new BackgroundTasks({ checkInterval: 100 });
  tasks.follow(transcript);
});

afterEach(() => {
  tasks.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// As Claude Code writes them (2.1), cut down to what matters.
function started(id: string, toolUseResult: object, outputFile?: string): string {
  const text = outputFile ? `Command running in background with ID: ${id}. Output is being written to: ${outputFile}. You will be notified.` : `Started ${id}.`;
  return `${JSON.stringify({
    parentUuid: "p",
    isSidechain: false,
    type: "user",
    message: { role: "user", content: [{ tool_use_id: `toolu_${id}`, type: "tool_result", content: text }] },
    uuid: `u-${id}`,
    timestamp: new Date().toISOString(),
    toolUseResult,
  })}\n`;
}

function ended(id: string, status: string): string {
  const content = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>${status}</status>\n<summary>Done</summary>\n</task-notification>`;
  return `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: new Date().toISOString(), sessionId: "s", content })}\n`;
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(check()).toBe(true);
}

test("counts what's started, until its notification", async () => {
  fs.appendFileSync(transcript, started("m1", { taskId: "m1", timeoutMs: 600000, persistent: false }));
  fs.appendFileSync(transcript, started("a1", { isAsync: true, status: "async_launched", agentId: "a1" }));
  await waitFor(() => tasks.counts()?.monitors === 1 && tasks.counts()?.agents === 1);
  // Not the one from before it was followed.
  expect(tasks.counts()).toEqual({ shells: 0, monitors: 1, agents: 1 });

  // A Monitor's events carry no status; its end does.
  fs.appendFileSync(transcript, ended("m1", "completed").replace("<status>completed</status>", "<event>tick</event>"));
  fs.appendFileSync(transcript, ended("a1", "completed"));
  await waitFor(() => tasks.counts()?.agents === 0);
  expect(tasks.counts()).toEqual({ shells: 0, monitors: 1, agents: 0 });
  fs.appendFileSync(transcript, ended("m1", "killed"));
  await waitFor(() => tasks.counts() === undefined);
});

test("a shell ends once nothing has its output file open, notification or not", async () => {
  const output = path.join(dir, "b1.output");
  const fd = fs.openSync(output, "w");
  const shell = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: ["ignore", fd, "ignore"] });
  // Only the shell's, as Claude Code leaves it.
  fs.closeSync(fd);
  fs.appendFileSync(transcript, started("b1", { backgroundTaskId: "b1" }, output));
  await waitFor(() => tasks.counts()?.shells === 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(tasks.counts()?.shells).toBe(1);

  shell.kill();
  await waitFor(() => tasks.counts() === undefined);
});

test("a monitor ends at its deadline", async () => {
  fs.appendFileSync(transcript, started("m2", { taskId: "m2", timeoutMs: -5000, persistent: false }));
  await waitFor(() => tasks.counts()?.monitors === 1);
  await waitFor(() => tasks.counts() === undefined);
});
