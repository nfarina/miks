import headless from "@xterm/headless";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { connectDaemon } from "../shared/connect.ts";
import type { ChatEntry, ClientMessage, DaemonMessage, DaemonState } from "../shared/protocol.ts";
import { type Daemon, serve } from "./daemon.ts";
import { Pane } from "./Pane.ts";

const { Terminal } = headless;

// A shell with no rc files, so the screen is predictable.
const COMMAND = ["/bin/bash", "--norc", "--noprofile"];

let home: string;
let daemon: Daemon;

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "miks test-"));
  daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: COMMAND });
});

afterEach(async () => {
  await daemon.close();
  fs.rmSync(home, { recursive: true, force: true });
});

/**
 * Ends a pane of a test's own, which the daemon's close doesn't know of, and
 * waits for it: zsh writes its history into `home` as it exits, and
 * afterEach deleting `home` meanwhile failed with ENOTEMPTY on a loaded
 * machine.
 */
async function end(pane: Pane) {
  const exited = new Promise((resolve) => pane.once("exit", resolve));
  pane.kill();
  await exited;
}

test("a new client sees exactly the screen the last one left, plus what happened since", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 80, rows: 24 });
  first.send({ type: "input", tabId, data: "PS1='$ '; printf '\\033[31mred\\033[0m\\n'; echo first-$((1+1))\n" });
  await first.waitForOutput(tabId, "first-2\r\n");
  first.close();

  // Output while nobody's watching still lands on the screen.
  daemon.workspaces.getPane(tabId)!.write("echo while-$((1+1))-away\n");
  await waitFor(() => paneText(tabId).then((text) => text.includes("while-2-away\n")));

  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId, cols: 80, rows: 24 });
  const screen = await second.screen(tabId);

  expect(screen.text).toContain("first-2");
  expect(screen.text).toContain("while-2-away");
  // Colors survive, since the snapshot is VT sequences rather than text.
  expect(second.snapshotFor(tabId)).toMatch(/\x1b\[31mred/);
  second.close();
});

test("a full-screen program comes back on the alternate screen", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 80, rows: 24 });
  // Switch to the alternate screen, draw at a position, and leave the shell
  // blocked so nothing else prints.
  first.send({ type: "input", tabId, data: "printf '\\033[?1049h\\033[5;10HFULL%sSCREEN' ' '; read\n" });
  await first.waitForOutput(tabId, "FULL SCREEN");
  first.close();

  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId, cols: 80, rows: 24 });
  const screen = await second.screen(tabId);

  expect(screen.terminal.buffer.active.type).toBe("alternate");
  expect(screen.lines[4].slice(9, 20)).toBe("FULL SCREEN");
  second.close();
});

test("a program's mouse reporting comes back with its encoding", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 80, rows: 24 });
  // What Claude Code asks for: button events, reported in SGR encoding.
  first.send({ type: "input", tabId, data: "printf '\\033[?1002h\\033[?1006hMOUSE%sON' ' '; read\n" });
  await first.waitForOutput(tabId, "MOUSE ON");
  first.close();

  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId, cols: 80, rows: 24 });
  const screen = await second.screen(tabId);

  expect(screen.terminal.modes.mouseTrackingMode).toBe("drag");
  expect(second.snapshotFor(tabId)).toContain("\x1b[?1006h");
  second.close();
});

test("attaching mid-stream neither drops nor repeats output", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const pane = daemon.workspaces.getPane(tabId)!;

  pane.write("PS1=''; for i in $(seq 1 20000); do echo line$i; done; echo ALL$((1))DONE\n");

  // Attach while the loop is still printing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const client = await connect();
  await client.state();
  client.send({ type: "attach", tabId, cols: 80, rows: 24 });
  await client.waitForOutput(tabId, "ALL1DONE\r\n");

  const screen = await client.screen(tabId);
  const numbers = screen.lines
    .map((line) => line.match(/^line(\d+)$/)?.[1])
    .filter(Boolean)
    .map(Number);

  // Every line the snapshot didn't already hold arrived exactly once, in order.
  expect(numbers.at(-1)).toBe(20000);
  for (let i = 1; i < numbers.length; i++) expect(numbers[i]).toBe(numbers[i - 1] + 1);
  expect(client.snapshotFor(tabId)).not.toContain("ALL1DONE");
  client.close();
});

test("attaching without a size leaves the pane alone and reports its size", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });

  const first = await connect();
  const tabId = activeTab(await first.state());
  first.send({ type: "attach", tabId, cols: 100, rows: 30 });
  // A trap shows whether the shell ever gets a SIGWINCH from here on.
  first.send({ type: "input", tabId, data: "trap 'echo WINCH-$((1+1))' WINCH; echo ready-$((1+1))\n" });
  await first.waitForOutput(tabId, "ready-2\r\n");
  first.close();

  // A tab that isn't on screen attaches without a size.
  const second = await connect();
  await second.state();
  second.send({ type: "attach", tabId });
  const snapshot = await second.snapshotMessage(tabId);
  expect([snapshot.cols, snapshot.rows]).toEqual([100, 30]);

  daemon.workspaces.getPane(tabId)!.write("echo after-$((1+1))\n");
  await second.waitForOutput(tabId, "after-2\r\n");
  expect(await paneText(tabId, 100, 30)).not.toContain("WINCH-2");
  second.close();
});

test("panes get their own MIKS_ variables, not the daemon's", async () => {
  // As when the dev build starts the daemon: its own MIKS_UI_URL, and a
  // MIKS_PANE_ID if it was launched from inside a Miks pane.
  process.env.MIKS_UI_URL = "http://localhost:2738/";
  process.env.MIKS_PANE_ID = "outer-pane";
  try {
    daemon.workspaces.createWorkspace({ cwd: home });
  } finally {
    delete process.env.MIKS_UI_URL;
    delete process.env.MIKS_PANE_ID;
  }
  const tabId = activeTab(daemon.workspaces.getState());

  daemon.workspaces.getPane(tabId)!.write('echo "url=[$MIKS_UI_URL] pane=[$MIKS_PANE_ID]"\n');
  await waitFor(() => paneText(tabId).then((text) => text.includes(`url=[] pane=[${tabId}]`)));
});

test("hooks drive the agent status", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const status = () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status;

  await postHook(tabId, { hook_event_name: "UserPromptSubmit" });
  expect(status()).toBe("working");

  await postHook(tabId, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Allow Bash?" });
  expect(status()).toBe("waiting");

  await postHook(tabId, { hook_event_name: "PostToolUse" });
  expect(status()).toBe("working");

  await postHook(tabId, { hook_event_name: "Stop" });
  // Once it's clear the session goes on (a one-shot one ends right away).
  await waitFor(() => status() === "done");

  // The idle reminder after a finished turn doesn't turn `done` into `waiting`.
  await postHook(tabId, { hook_event_name: "Notification", notification_type: "idle_prompt" });
  expect(status()).toBe("done");

  daemon.workspaces.select(daemon.workspaces.getState().workspaces[0].id, tabId);
  expect(status()).toBe("idle");

  await postHook(tabId, { hook_event_name: "SessionEnd" });
  expect(status()).toBeUndefined();
});

test("a one-shot claude -p shows working, then nothing: never done, never a notification", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const statuses: (string | undefined)[] = [];
  daemon.workspaces.on("change", () => statuses.push(daemon.workspaces.getState().workspaces[0]?.tabs[0]?.agent?.status));

  // What claude -p sends, in order (captured from a real run).
  const session = { session_id: "c758b276-c321-4b47-a71d-c21d0c14df2b" };
  await postHook(tabId, { ...session, hook_event_name: "SessionStart", source: "startup" });
  await postHook(tabId, { ...session, hook_event_name: "UserPromptSubmit" });
  await postHook(tabId, { ...session, hook_event_name: "Stop" });
  await postHook(tabId, { ...session, hook_event_name: "SessionEnd", reason: "other" });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  expect(statuses).toContain("working");
  expect(statuses).not.toContain("done");
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].agent).toBeNull();
  // Nor is it a session to resume.
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].kept).toBe(false);
});

test("an interrupted turn ends when Claude's title stops spinning", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const pane = daemon.workspaces.getPane(tabId)!;
  const status = () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status;
  // Sets the title the way Claude Code does, with OSC 0.
  const title = async (text: string) => {
    pane.write(`printf '\\033]0;${text}\\007'\n`);
    await waitFor(() => daemon.workspaces.getState().workspaces[0].tabs[0].title === text);
  };

  await title("✳ Claude Code");
  await postHook(tabId, { hook_event_name: "SessionStart" });

  // A ✳ title still arriving after the prompt went in doesn't end the turn;
  // only the spinner stopping does.
  await postHook(tabId, { hook_event_name: "UserPromptSubmit" });
  await title("✳ Numbers");
  expect(status()).toBe("working");

  await title("◐ Numbers");
  await title("◑ Numbers");
  expect(status()).toBe("working");

  // Esc: no Stop hook, just the title.
  await title("✳ Numbers");
  expect(status()).toBe("idle");
});

test("Claude's idle reminder clears a turn that never ended", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const status = () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status;

  await postHook(tabId, { hook_event_name: "UserPromptSubmit" });
  await postHook(tabId, { hook_event_name: "Notification", notification_type: "idle_prompt" });
  expect(status()).toBe("idle");
});

test("a restarted daemon brings back the layout, each tab's directory, and its Claude session", async () => {
  // Its own pair of daemons, persisting to one file.
  await daemon.close();
  const statePath = path.join(home, "state.json");
  const socketPath = path.join(home, "miks.sock");
  const subdir = path.join(home, "sub dir");
  fs.mkdirSync(subdir);

  const first = await serve({ socketPath, statePath, command: COMMAND, claudeCommand: "echo RESUMING" });
  expect(first.restored).toBe(false);
  const workspaceId = first.workspaces.createWorkspace({ cwd: home });
  first.workspaces.renameWorkspace(workspaceId, "Agents");
  const shellTab = activeTab(first.workspaces.getState());
  const claudeTab = first.workspaces.createTab(workspaceId)!;
  await postHook(claudeTab, { hook_event_name: "SessionStart", session_id: "1234abcd-0000-4000-8000-000000000000" });
  const keys = first.workspaces.getState().workspaces[0].tabs.map((tab) => tab.key);

  // The shell moves; the saved layout should follow it there.
  first.workspaces.getPane(shellTab)!.write(`cd '${subdir}'\n`);
  await waitFor(async () => (await first.workspaces.getPane(shellTab)!.cwd()) === fs.realpathSync(subdir));
  first.workspaces.select(workspaceId, shellTab);
  await first.close();

  daemon = await serve({ socketPath, statePath, command: COMMAND, claudeCommand: "echo RESUMING" });
  expect(daemon.restored).toBe(true);

  const [workspace] = daemon.workspaces.getState().workspaces;
  expect(workspace.title).toBe("Agents");
  expect(workspace.tabs).toHaveLength(2);
  // The same tab is selected as before.
  expect(workspace.activeTabId).toBe(workspace.tabs[0].id);

  const [restoredShell, restoredClaude] = workspace.tabs;
  // New panes, but the same tabs: what the UI keeps about each comes back.
  expect(workspace.tabs.map((tab) => tab.key)).toEqual(keys);
  expect(keys.every(Boolean)).toBe(true);
  expect(restoredShell.id).not.toBe(shellTab);
  await waitFor(async () => (await daemon.workspaces.getPane(restoredShell.id)!.cwd()) === fs.realpathSync(subdir));

  // Each tab keeps its own shell history file.
  const savedHistory = JSON.parse(fs.readFileSync(statePath, "utf8")).workspaces[0].tabs[0].historyId;
  expect(savedHistory).toBeTruthy();
  const expected = path.join(home, "history", `${savedHistory}.zsh`);
  daemon.workspaces.getPane(restoredShell.id)!.write(`[ "$MIKS_HISTORY" = '${expected}' ] && echo SAME-$((1+1))\n`);
  await waitFor(() => paneText(restoredShell.id).then((text) => text.includes("SAME-2")));
  await waitFor(() =>
    paneText(restoredClaude.id).then((text) => text.includes("RESUMING --resume 1234abcd-0000-4000-8000-000000000000")),
  );
});

test("a session with no transcript isn't resumed", async () => {
  await daemon.close();
  const statePath = path.join(home, "state.json");
  const socketPath = path.join(home, "miks.sock");
  const transcript = path.join(home, "transcript.jsonl");

  const first = await serve({ socketPath, statePath, command: COMMAND });
  first.workspaces.createWorkspace({ cwd: home });
  const [blank, used] = [activeTab(first.workspaces.getState()), first.workspaces.createTab(first.workspaces.getState().workspaces[0].id)!];
  // A fresh session with no message yet has a transcript path but no file.
  await postHook(blank, { hook_event_name: "SessionStart", session_id: "blank", transcript_path: path.join(home, "none.jsonl") });
  fs.writeFileSync(transcript, "{}\n");
  await postHook(used, { hook_event_name: "SessionStart", session_id: "used", transcript_path: transcript });
  await first.close();

  const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
  expect(saved.workspaces[0].tabs.map((tab: any) => tab.claudeSessionId)).toEqual([undefined, "used"]);
  daemon = await serve({ socketPath, statePath, command: COMMAND });
});

test("a tab's page comes back where it had gone", async () => {
  await daemon.close();
  const statePath = path.join(home, "state.json");
  const socketPath = path.join(home, "miks.sock");

  const first = await serve({ socketPath, statePath, command: COMMAND });
  first.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(first.workspaces.getState());
  first.workspaces.openPage(tabId, "http://localhost:2727/");
  const { id } = first.workspaces.getState().workspaces[0].tabs[0].page!;
  first.workspaces.pageNavigated(tabId, "http://localhost:2727/dash");
  // Still the same page: the panel doesn't load it again.
  expect(first.workspaces.getState().workspaces[0].tabs[0].page).toEqual({ id, url: "http://localhost:2727/dash" });
  await first.close();

  daemon = await serve({ socketPath, statePath, command: COMMAND });
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].page?.url).toBe("http://localhost:2727/dash");
});

test("a window hears the size another window gave its pane, and the one that gave it doesn't", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const mac = await connect();
  const ipad = await connect();
  mac.send({ type: "attach", tabId, cols: 120, rows: 40 });
  await mac.snapshotMessage(tabId);
  ipad.send({ type: "attach", tabId });
  expect(await ipad.snapshotMessage(tabId)).toMatchObject({ cols: 120, rows: 40 });

  // The iPad is used: the Mac draws at its size until it's used again.
  ipad.send({ type: "resize", tabId, cols: 70, rows: 30 });
  expect(await mac.next((m) => m.type === "size")).toEqual({ type: "size", tabId, cols: 70, rows: 30 });

  // And back, the first key on the Mac.
  mac.send({ type: "resize", tabId, cols: 120, rows: 40 });
  expect(await ipad.next((m) => m.type === "size")).toEqual({ type: "size", tabId, cols: 120, rows: 40 });
  // A size the pane already has changes nothing.
  ipad.send({ type: "resize", tabId, cols: 120, rows: 40 });
  await new Promise((resolve) => setTimeout(resolve, 200));

  // Neither heard its own: one dragging a window edge has already moved on.
  expect(mac.sizes(tabId).map((m) => m.cols)).toEqual([70]);
  expect(ipad.sizes(tabId).map((m) => m.cols)).toEqual([120]);
  mac.close();
  ipad.close();
});

test("panes don't inherit Claude Code's own variables", async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = "1";
  process.env.CLAUDECODE = "1";
  try {
    daemon.workspaces.createWorkspace({ cwd: home });
  } finally {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.CLAUDECODE;
  }
  const tabId = activeTab(daemon.workspaces.getState());

  daemon.workspaces.getPane(tabId)!.write('echo "child=[$CLAUDE_CODE_CHILD_SESSION] code=[$CLAUDECODE]"\n');
  await waitFor(() => paneText(tabId).then((text) => text.includes("child=[] code=[]")));
});

test("a session that ended isn't resumed", async () => {
  await daemon.close();
  const statePath = path.join(home, "state.json");
  const socketPath = path.join(home, "miks.sock");

  const first = await serve({ socketPath, statePath, command: COMMAND, claudeCommand: "echo RESUMING" });
  first.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(first.workspaces.getState());
  await postHook(tabId, { hook_event_name: "SessionStart", session_id: "ended-session" });
  await postHook(tabId, { hook_event_name: "SessionEnd", session_id: "ended-session" });
  await first.close();

  expect(JSON.parse(fs.readFileSync(statePath, "utf8")).workspaces[0].tabs[0].claudeSessionId).toBeUndefined();
  daemon = await serve({ socketPath, statePath, command: COMMAND });
  expect(daemon.workspaces.getState().workspaces).toHaveLength(1);
});

test("workspaces and tabs move where they're dropped", async () => {
  const [a, b, c] = [1, 2, 3].map((n) => daemon.workspaces.createWorkspace({ cwd: home, title: `W${n}` }));
  const order = () => daemon.workspaces.getState().workspaces.map((w) => w.title);

  daemon.workspaces.moveWorkspace(c, 0);
  expect(order()).toEqual(["W3", "W1", "W2"]);
  daemon.workspaces.moveWorkspace(c, 99);
  expect(order()).toEqual(["W1", "W2", "W3"]);

  const first = daemon.workspaces.getState().workspaces[0].tabs[0].id;
  const second = daemon.workspaces.createTab(a)!;
  const third = daemon.workspaces.createTab(a)!;
  daemon.workspaces.moveTab(third, 0);
  expect(daemon.workspaces.getState().workspaces[0].tabs.map((t) => t.id)).toEqual([third, first, second]);
  void b;
});

test("each tab reports the directory its shell is in", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const subdir = path.join(home, "elsewhere");
  fs.mkdirSync(subdir);

  daemon.workspaces.getPane(tabId)!.write(`cd '${subdir}'\n`);
  await waitFor(async () => {
    await daemon.workspaces.pollCwds();
    return daemon.workspaces.getState().workspaces[0].tabs[0].cwd === fs.realpathSync(subdir);
  });
});

test("a program in front of the shell is reported as running", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  expect(daemon.workspaces.running()).toEqual([]);

  daemon.workspaces.getPane(tabId)!.write("sleep 30\n");
  await waitFor(() => daemon.workspaces.running()[0]?.program === "sleep");
  expect(daemon.workspaces.running()[0]).toMatchObject({ kept: false, active: false });

  // Kept, it'd come back; mid-turn, it'd still be cut short.
  daemon.workspaces.keep(tabId, "sleep 30");
  await postHook(tabId, { hook_event_name: "UserPromptSubmit" });
  expect(daemon.workspaces.running()[0]).toMatchObject({ kept: true, active: true });
  // And on its tab, for asking before closing it.
  await waitFor(() => {
    daemon.workspaces.pollForeground();
    return daemon.workspaces.getState().workspaces[0].tabs[0].running === "sleep";
  });
});

test("a Claude session's background work is reported with what's running", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const transcript = path.join(home, "session.jsonl");
  fs.writeFileSync(transcript, "");
  await postHook(tabId, { hook_event_name: "SessionStart", session_id: "s1", transcript_path: transcript });
  daemon.workspaces.getPane(tabId)!.write("sleep 30\n");
  await waitFor(() => daemon.workspaces.running()[0]?.program === "sleep");

  const toolUseResult = { taskId: "m1", timeoutMs: 600000, persistent: false };
  fs.appendFileSync(transcript, `${JSON.stringify({ parentUuid: "p", type: "user", uuid: "u1", timestamp: new Date().toISOString(), toolUseResult })}\n`);
  await waitFor(() => daemon.workspaces.running()[0]?.background?.monitors === 1);
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].background).toEqual({ shells: 0, monitors: 1, agents: 0 });
});

test("a new tab starts where the current one is", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const workspaceId = daemon.workspaces.getState().workspaces[0].id;
  const tabId = activeTab(daemon.workspaces.getState());
  const subdir = path.join(home, "elsewhere");
  fs.mkdirSync(subdir);

  const pane = daemon.workspaces.getPane(tabId)!;
  pane.write(`cd '${subdir}'\n`);
  await waitFor(async () => (await pane.cwd()) === fs.realpathSync(subdir));

  const newTabId = (await daemon.workspaces.newTab(workspaceId))!;
  expect(await daemon.workspaces.getPane(newTabId)!.cwd()).toBe(fs.realpathSync(subdir));
});

test("a new tab goes just right of the current one", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const workspaceId = daemon.workspaces.getState().workspaces[0].id;
  const first = activeTab(daemon.workspaces.getState());
  const last = daemon.workspaces.createTab(workspaceId)!;
  daemon.workspaces.select(workspaceId, first);

  const newTabId = (await daemon.workspaces.newTab(workspaceId))!;
  expect(daemon.workspaces.getState().workspaces[0].tabs.map((tab) => tab.id)).toEqual([first, newTabId, last]);
});

test("zsh reads your startup files, gives ZDOTDIR back, and marks each command", async () => {
  for (const file of [".zshenv", ".zprofile", ".zshrc", ".zlogin"]) {
    fs.writeFileSync(path.join(home, file), `MIKS_TEST_READ="$MIKS_TEST_READ ${file}"\n`);
  }
  fs.appendFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");

  const pane = new Pane({ id: "zsh", cwd: home, env: { HOME: home }, command: ["/bin/zsh", "-l"] });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    pane.write("echo read:$MIKS_TEST_READ zdotdir:${ZDOTDIR-unset}\n");
    await waitFor(() => /\x1b\]133;D;0\x07/.test(output));

    expect(output).toContain("read: .zshenv .zprofile .zshrc .zlogin zdotdir:unset");
    // The prompt, the command's output, its end, the next prompt.
    expect(output.indexOf("\x1b]133;C\x07")).toBeLessThan(output.indexOf("read: .zshenv"));
    expect(output.lastIndexOf("\x1b]133;A\x07")).toBeGreaterThan(output.indexOf("\x1b]133;D;0\x07"));
  } finally {
    await end(pane);
  }
});

test("zsh's history is yours, not saved inside Miks's own folder", async () => {
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");
  const pane = new Pane({ id: "zsh", cwd: home, env: { HOME: home }, command: ["/bin/zsh", "-l"] });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    pane.write("echo histfile:$HISTFILE\n");
    await waitFor(() => /\x1b\]133;D;0\x07/.test(output));
    expect(output).toContain(`histfile:${home}/.zsh_history`);
  } finally {
    await end(pane);
  }
});

test("a folder dropped on another Mac's window lands in the tab's folder, never over anything", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "miks-source-"));
  fs.mkdirSync(path.join(source, "my stuff", "inner"), { recursive: true });
  fs.writeFileSync(path.join(source, "my stuff", "inner", "notes.txt"), "hi");

  const first = await drop(`/api/drop?pane=${tabId}&into=cwd`, source, "my stuff");
  expect(first).toBe(path.join(fs.realpathSync(home), "my stuff"));
  expect(fs.readFileSync(path.join(first, "inner", "notes.txt"), "utf8")).toBe("hi");

  // Dropped again, it's a second copy.
  expect(await drop(`/api/drop?pane=${tabId}&into=cwd`, source, "my stuff")).toBe(`${first} 2`);
  // And nothing's left over.
  expect(fs.readdirSync(home).filter((name) => name.startsWith(".miks-drop-"))).toEqual([]);
  fs.rmSync(source, { recursive: true });
});

test("an image dropped on another Mac's window goes to a temporary folder", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "miks-source-"));
  fs.writeFileSync(path.join(source, "screen shot.png"), "PNG!");

  const saved = await drop(`/api/drop?pane=${tabId}&into=tmp`, source, "screen shot.png");
  expect(path.basename(saved)).toBe("screen shot.png");
  expect(fs.readFileSync(saved, "utf8")).toBe("PNG!");
  expect(fs.readdirSync(home)).not.toContain("screen shot.png");
  fs.rmSync(path.dirname(saved), { recursive: true });
  fs.rmSync(source, { recursive: true });
});

test("in zsh, ⌥← moves back a word", async () => {
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");
  const pane = new Pane({ id: "zsh", cwd: home, env: { HOME: home }, command: ["/bin/zsh", "-l"] });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    // What xterm.js sends for ⌥← with Option as Meta.
    pane.write("echo one two");
    pane.write("\x1b[1;3D");
    pane.write("X\n");
    await waitFor(() => output.includes("one Xtwo\r\n"));
  } finally {
    await end(pane);
  }
});

test("closing the last workspace starts a new one", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const first = daemon.workspaces.getState().workspaces[0].id;

  daemon.workspaces.closeWorkspace(first);
  await waitFor(() => {
    const { workspaces, activeWorkspaceId } = daemon.workspaces.getState();
    return workspaces.length === 1 && workspaces[0].id !== first && activeWorkspaceId === workspaces[0].id;
  });
});

test("pbcopy in a zsh tab also copies through the terminal, for windows on other Macs", async () => {
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");
  const copied = path.join(home, "copied");
  // Apple's pbcopy would be the real clipboard; this stands in for it.
  const fake = path.join(home, "fake-pbcopy");
  fs.writeFileSync(fake, `#!/bin/sh\ncat > '${copied}'\n`, { mode: 0o755 });

  const pane = new Pane({
    id: "zsh",
    cwd: home,
    env: { HOME: home, MIKS_REAL_PBCOPY: fake },
    command: ["/bin/zsh", "-l"],
  });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    pane.write("printf 'two\\nlines\\n' | pbcopy\n");
    const osc52 = `\x1b]52;c;${Buffer.from("two\nlines\n").toString("base64")}\x07`;
    await waitFor(() => output.includes(osc52));
    // Still copied the usual way too, trailing newline and all.
    expect(fs.readFileSync(copied, "utf8")).toBe("two\nlines\n");
  } finally {
    await end(pane);
  }
});

test("a zsh tab's own commands come back first on ↑ when it's restored", async () => {
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");
  const history = path.join(home, "tab.zsh");
  const run = async (input: string[], until: string) => {
    const pane = new Pane({ id: "zsh", cwd: home, env: { HOME: home, MIKS_HISTORY: history }, command: ["/bin/zsh", "-l"] });
    let output = "";
    pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
    try {
      await waitFor(() => output.includes("\x1b]133;A\x07"));
      for (const data of input) {
        pane.write(data);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await waitFor(() => output.includes(until));
    } finally {
      await end(pane);
    }
  };

  await run(["echo first-$((1+1))\n", "echo 'multi\nline'\n", "echo done-$((2+2))\n"], "done-4");
  // Recorded as they ran, the newline inside the second kept as zsh writes it.
  expect(fs.readFileSync(history, "utf8")).toBe("echo first-$((1+1))\necho 'multi\\\nline'\necho done-$((2+2))\n");

  // A new shell on the same file (a restored tab): ↑↑ is the multi-line one.
  await run(["\x1b[A", "\x1b[A", "\r"], "multi\r\nline");
  // Two zsh startups in a row, slow when the whole suite runs at once.
}, 20_000);

test("after its Mac's Miks quits, the daemon stops when the last window goes", async () => {
  await daemon.close();
  const stops: boolean[] = [];
  daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: COMMAND, onStop: (restart) => stops.push(restart) });

  const local = await connect();
  const remote = await connect();
  await local.state();
  await remote.state();

  // The Mac's own Miks quits, with a window on another Mac still open.
  local.send({ type: "stopWhenIdle", value: true });
  await local.state(); // The message has landed.
  local.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stops).toEqual([]);

  remote.close();
  await waitFor(() => stops.length === 1);
  expect(stops).toEqual([false]);
});

test("Miks coming back cancels the stop, and any window can ask for a restart", async () => {
  await daemon.close();
  const stops: boolean[] = [];
  daemon = await serve({ socketPath: path.join(home, "miks.sock"), command: COMMAND, onStop: (restart) => stops.push(restart) });

  const remote = await connect();
  await remote.state();
  remote.send({ type: "stopWhenIdle", value: true });
  const local = await connect();
  local.send({ type: "stopWhenIdle", value: false });
  await local.state();
  remote.close();
  local.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(stops).toEqual([]);

  expect(await apiPost("/api/restart")).toBe(200);
  await waitFor(() => stops.length === 1);
  expect(stops).toEqual([true]);
});

test("miks keep: a kept command is saved, runs again on restore, and is let go when it ends", async () => {
  await daemon.close();
  const statePath = path.join(home, "state.json");
  const socketPath = path.join(home, "miks.sock");

  const first = await serve({ socketPath, statePath, command: COMMAND });
  first.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(first.workspaces.getState());
  const kept = (workspaces: Daemon["workspaces"]) => workspaces.getState().workspaces[0].tabs[0].kept;

  // What `miks keep` sends, then runs.
  await apiPostText(`/api/keep?pane=${tabId}`, "echo KEPT-$((1+1)); sleep 30");
  first.workspaces.getPane(tabId)!.write("sleep 30\n");
  expect(kept(first.workspaces)).toBe(true);
  await first.close();

  daemon = await serve({ socketPath, statePath, command: COMMAND });
  const restored = activeTab(daemon.workspaces.getState());
  expect(kept(daemon.workspaces)).toBe(true);
  await waitFor(() => paneText(restored).then((text) => text.includes("KEPT-2")));

  // Seen running, then the shell's back (Ctrl-C here): no longer kept.
  await waitFor(() => {
    daemon.workspaces.pollForeground();
    return daemon.workspaces.getState().workspaces[0].tabs[0].running === "sleep";
  });
  daemon.workspaces.getPane(restored)!.write("\x03");
  await waitFor(() => {
    daemon.workspaces.pollForeground();
    return kept(daemon.workspaces) === false;
  });
});

test("the miks keep function in zsh registers the command, quoted, then runs it", async () => {
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");
  const http = await import("http");
  const sock = path.join(home, "capture.sock");
  const received: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push(`${req.url} ${body}`);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(sock, resolve));

  const pane = new Pane({ id: "zsh", cwd: home, env: { HOME: home, MIKS_PANE_ID: "p1", MIKS_SOCKET: sock }, command: ["/bin/zsh", "-l"] });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    pane.write("miks keep echo 'two words' ran-$((1+1))\n");
    await waitFor(() => output.includes("two words ran-2"));
    expect(received).toEqual(["/api/keep?pane=p1 echo 'two words' ran-2"]);
  } finally {
    await end(pane);
    server.close();
  }
});

test("miks edit --wait: the file opens in the tab's panel, saves, follows the disk, and returns once closed", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const file = path.join(fs.realpathSync(home), "notes.txt");
  fs.writeFileSync(path.join(home, ".zshrc"), "PS1='%% '\n");

  // A zsh tab of the daemon's, as far as `miks` can tell.
  const pane = new Pane({
    id: "zsh",
    cwd: home,
    env: { HOME: home, MIKS_PANE_ID: tabId, MIKS_SOCKET: path.join(home, "miks.sock") },
    command: ["/bin/zsh", "-l"],
  });
  let output = "";
  pane.attach({ snapshot: () => {}, output: (data) => (output += data) });
  const client = await connect();
  try {
    await waitFor(() => output.includes("\x1b]133;A\x07"));
    pane.write("[[ $EDITOR == */miks-editor && $VISUAL == $EDITOR ]] && echo EDITOR-$((1+1)); miks open missing.txt\n");
    await waitFor(() => output.includes("EDITOR-2") && output.includes("no such file: missing.txt"));

    // As git runs it: $EDITOR with a path, relative to where it's run.
    pane.write("$EDITOR notes.txt; echo DONE-$((1+1))\n");
    await waitFor(() => daemon.workspaces.getState().workspaces[0].tabs[0].file?.path === file);
    const opened = daemon.workspaces.getState().workspaces[0].tabs[0].file!;
    expect(opened).toMatchObject({ edit: true, wait: true });

    // Not there yet: empty, with no mtime, and saving makes it.
    client.send({ type: "watchFile", tabId });
    const fresh = await client.next((m) => m.type === "file");
    expect(fresh).toMatchObject({ id: opened.id, content: "", mtime: null });
    client.send({ type: "saveFile", tabId, content: "first", mtime: null });
    const saved = (await client.next((m) => m.type === "fileSaved")) as Extract<DaemonMessage, { type: "fileSaved" }>;
    expect(fs.readFileSync(file, "utf8")).toBe("first");
    expect(saved.mtime).toBeTypeOf("number");

    // Changed on disk since: refused, unless forced.
    fs.writeFileSync(file, "theirs");
    await waitFor(async () => (await client.files(tabId)).some((m) => m.content === "theirs"));
    client.send({ type: "saveFile", tabId, content: "mine", mtime: saved.mtime! });
    await waitFor(async () => (await client.saves(tabId)).some((m) => m.changed));
    expect(fs.readFileSync(file, "utf8")).toBe("theirs");

    expect(output).not.toContain("DONE-2");
    client.send({ type: "closeFile", tabId });
    await waitFor(() => output.includes("DONE-2"));
    expect(daemon.workspaces.getState().workspaces[0].tabs[0].file).toBeUndefined();
  } finally {
    client.close();
    await end(pane);
  }
});

test("the panel won't open what it can't show", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const binary = path.join(home, "image.bin");
  fs.writeFileSync(binary, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  await daemon.workspaces.openFile(tabId, binary, { edit: false, wait: false });

  const client = await connect();
  client.send({ type: "watchFile", tabId });
  expect(await client.next((m) => m.type === "file")).toMatchObject({ content: null, problem: "binary" });
  client.close();
});

test("programs that set mode 2031 hear when the appearance changes", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const pane = daemon.workspaces.getPane(tabId)!;

  // Ask for reports, then read what arrives on stdin, as Claude Code would:
  // the current scheme right away (Claude never asks for it), then the change.
  pane.write("stty -echo -icanon; printf '\\033[?2031h'; dd bs=1 count=18 2>/dev/null | od -An -c\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  daemon.workspaces.setDark(false);

  const report = (n: number) => `033\\s+\\[\\s+\\?\\s+9\\s+9\\s+7\\s+;\\s+${n}\\s+n`;
  await waitFor(() => paneText(tabId).then((text) => new RegExp(`${report(1)}[\\s\\S]*${report(2)}`).test(text)));
});

test("a tab is called by the program in front, unless that program titled it", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const pane = daemon.workspaces.getPane(tabId)!;
  const title = () => {
    daemon.workspaces.pollForeground();
    return daemon.workspaces.getState().workspaces[0].tabs[0].title;
  };

  // Like top: sets no title of its own.
  pane.write("sleep 2\n");
  await waitFor(() => title() === "sleep");
  await waitFor(() => title() === "bash", 4000);

  // A title the shell itself sets stands while the shell is in front...
  pane.write("printf '\\033]0;my title\\007'\n");
  await waitFor(() => title() === "my title");
  // ...but not over a program that came after it.
  pane.write("sleep 2\n");
  await waitFor(() => title() === "sleep");
});

test("the chat panel gets a tab's conversation, then each new message, through its sessions", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const first = path.join(home, "first.jsonl");
  const second = path.join(home, "second.jsonl");
  // As Claude Code writes them: what each follows, first.
  const message = (uuid: string, type: "user" | "assistant", text: string, parentUuid: string | null) =>
    JSON.stringify({
      parentUuid,
      type,
      uuid,
      timestamp: new Date().toISOString(),
      message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
    }) + "\n";

  fs.writeFileSync(first, message("a", "user", "Hello", null) + message("b", "assistant", "Hi **there**", "a"));
  await postHook(tabId, { hook_event_name: "SessionStart", session_id: "first", transcript_path: first });

  const client = await connect();
  await client.state();
  const chats: Extract<DaemonMessage, { type: "chat" }>[] = [];
  // As the UI rebuilds it: a reset replaces the conversation, the rest add to it.
  const texts = () =>
    chats
      .reduce<ChatEntry[]>((all, chat) => (chat.reset ? chat.entries : [...all, ...chat.entries]), [])
      .map((entry) => ("text" in entry ? entry.text : ""));
  client.send({ type: "watchChat", tabId });
  const watch = async (until: () => boolean) => {
    await waitFor(async () => {
      chats.length = 0;
      chats.push(...(await client.chats(tabId)));
      return until();
    });
  };

  await watch(() => texts().join("|") === "Hello|Hi **there**");
  // Not empty and then filled in: all of it, once it's been read.
  expect(chats[0]).toMatchObject({ reset: true, session: "first" });
  expect(chats[0].entries).toHaveLength(2);

  // Appended in two writes, the second finishing the line.
  const more = message("c", "user", "And then?", "b");
  fs.appendFileSync(first, more.slice(0, 20));
  await new Promise((resolve) => setTimeout(resolve, 400));
  fs.appendFileSync(first, more.slice(20));
  await watch(() => texts().join("|") === "Hello|Hi **there**|And then?");

  // A rewind (Esc Esc) to before "And then?": what's after it stays in the
  // file, but the conversation goes on from "Hi there" without it.
  fs.appendFileSync(first, message("e", "user", "Something else", "b"));
  await watch(() => texts().join("|") === "Hello|Hi **there**|Something else");
  expect(chats.at(-1)).toMatchObject({ reset: true });

  // A new session (/clear) starts the conversation over.
  fs.writeFileSync(second, message("d", "user", "Fresh start", null));
  await postHook(tabId, { hook_event_name: "SessionStart", session_id: "second", transcript_path: second });
  await watch(() => texts().at(-1) === "Fresh start");
  const reset = chats.findLast((chat) => chat.reset)!;
  expect(reset).toMatchObject({ session: "second" });
  expect(chats.slice(chats.indexOf(reset)).flatMap((chat) => chat.entries).map((entry) => entry.id)).toEqual(["d"]);

  // The reply's length, for opening the panel on long ones.
  await postHook(tabId, { hook_event_name: "Stop", session_id: "second", transcript_path: second, last_assistant_message: "a\nb\nc" });
  await waitFor(() => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.replyLines === 3);
  // And its start, for the notification.
  expect(daemon.workspaces.getState().workspaces[0].tabs[0].agent?.reply).toBe("a\nb\nc");
  client.close();
});

test("the hook script posts to the daemon from inside a pane", async () => {
  daemon.workspaces.createWorkspace({ cwd: home });
  const tabId = activeTab(daemon.workspaces.getState());
  const script = path.resolve(import.meta.dirname, "../hooks/claude-hook.sh");

  // What Claude Code does: run the hook with the event's JSON on stdin, in
  // the pane's environment.
  daemon.workspaces.getPane(tabId)!.write(`echo '{"hook_event_name":"UserPromptSubmit"}' | ${script}\n`);

  await waitFor(async () => daemon.workspaces.getState().workspaces[0].tabs[0].agent?.status === "working");
});

//
// Helpers.
//

function activeTab(state: DaemonState): string {
  const workspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId)!;
  return workspace.activeTabId!;
}

/** The pane's own screen, read the same way a client would. */
async function paneText(tabId: string, cols = 80, rows = 24): Promise<string> {
  const client = await connect();
  await client.state();
  client.send({ type: "attach", tabId, cols, rows });
  const screen = await client.screen(tabId);
  client.close();
  return screen.text;
}

/** A POST with a text body; resolves with the status. */
async function apiPostText(apiPath: string, body: string): Promise<number> {
  const http = await import("http");
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(home, "miks.sock"), path: apiPath, method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** POSTs a tar of `name` in `folder`, as Miks.app does a drop; resolves with where it was saved. */
async function drop(apiPath: string, folder: string, name: string): Promise<string> {
  const http = await import("http");
  const { execFileSync } = await import("child_process");
  const tar = execFileSync("tar", ["-cf", "-", "-C", folder, name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(home, "miks.sock"), path: apiPath, method: "POST" }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(JSON.parse(body).path));
    });
    req.on("error", reject);
    req.end(tar);
  });
}

/** A POST with no body; resolves with the status. */
async function apiPost(apiPath: string): Promise<number> {
  const http = await import("http");
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(home, "miks.sock"), path: apiPath, method: "POST" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function postHook(tabId: string, payload: any) {
  const http = await import("http");
  await new Promise<void>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: path.join(home, "miks.sock"),
        path: `/api/hook?pane=${tabId}`,
        method: "POST",
      },
      (res) => {
        res.resume();
        res.on("end", resolve);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, timeout = 5000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeout) throw new Error("Timed out.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * A test client that rebuilds each pane's screen the way the UI does: write
 * the snapshot into a fresh terminal, then every `output` after it.
 */
async function connect() {
  const socket = connectDaemon(path.join(home, "miks.sock"));
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const messages: DaemonMessage[] = [];
  const listeners = new Set<() => void>();
  socket.on("message", (raw) => {
    messages.push(JSON.parse(raw.toString()));
    for (const listener of listeners) listener();
  });

  const until = <T>(find: () => T | undefined): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for the daemon.")), 5000);
      const check = () => {
        const found = find();
        if (found === undefined) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve(found);
      };
      listeners.add(check);
      check();
    });

  const streamFor = (tabId: string) => {
    const start = messages.findIndex((m) => m.type === "snapshot" && m.tabId === tabId);
    if (start === -1) return undefined;
    return messages
      .slice(start)
      .filter((m) => (m.type === "snapshot" || m.type === "output") && m.tabId === tabId)
      .map((m) => (m as { data: string }).data)
      .join("");
  };

  return {
    send: (message: ClientMessage) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
    next: (match: (message: DaemonMessage) => boolean) => until(() => messages.find(match)),
    state: async () => {
      socket.send(JSON.stringify({ type: "hello" } satisfies ClientMessage));
      const message = await until(() => messages.findLast((m) => m.type === "state"));
      return message.state;
    },
    files: async (tabId: string) =>
      messages.filter((m) => m.type === "file" && m.tabId === tabId) as Extract<DaemonMessage, { type: "file" }>[],
    saves: async (tabId: string) =>
      messages.filter((m) => m.type === "fileSaved" && m.tabId === tabId) as Extract<DaemonMessage, { type: "fileSaved" }>[],
    sizes: (tabId: string) =>
      messages.filter((m) => m.type === "size" && m.tabId === tabId) as Extract<DaemonMessage, { type: "size" }>[],
    chats: async (tabId: string) =>
      messages.filter((m) => m.type === "chat" && m.tabId === tabId) as Extract<DaemonMessage, { type: "chat" }>[],
    snapshotMessage: (tabId: string) =>
      until(() => messages.find((m) => m.type === "snapshot" && m.tabId === tabId) as
        | Extract<DaemonMessage, { type: "snapshot" }>
        | undefined),
    snapshotFor: (tabId: string) =>
      (messages.find((m) => m.type === "snapshot" && m.tabId === tabId) as { data: string } | undefined)?.data,
    waitForOutput: (tabId: string, text: string) =>
      until(() => {
        // The shell echoes what we type, so tests wait for text only the
        // command's output contains (`$((1+1))` prints `2`).
        const stream = streamFor(tabId) ?? "";
        return stream.includes(text) ? true : undefined;
      }),
    screen: async (tabId: string) => {
      const stream = await until(() => streamFor(tabId));
      const terminal = new Terminal({ cols: 80, rows: 24, scrollback: 10_000, allowProposedApi: true });
      await new Promise<void>((resolve) => terminal.write(stream, resolve));

      const buffer = terminal.buffer.active;
      const lines: string[] = [];
      // On the alternate screen, rows are indexed from the top of the screen.
      const first = buffer.type === "alternate" ? buffer.baseY : 0;
      for (let i = first; i < buffer.length; i++) lines.push(buffer.getLine(i)?.translateToString(true) ?? "");

      return { terminal, lines, text: lines.join("\n") + "\n" };
    },
  };
}
