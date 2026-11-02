// The Codex hooks behind each tab's agent status, in ~/.codex/hooks.json,
// which Codex reads as Claude Code does its settings' `hooks`. The script is a
// no-op outside Miks, so having it global costs nothing.
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { hookCommand, syncHooks } from "./claudeHooks.ts";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "SessionEnd"];

/** How long Codex's app server gets; a login shell's startup files come first. */
const TIMEOUT = 20_000;

const isOurs = (hook: any) =>
  typeof hook?.command === "string" && /miks/i.test(hook.command) && /codex-hook\.sh'?$/.test(hook.command);

/**
 * Adds or removes our hooks, touching nothing else in the file, and has Codex
 * trust them: new hooks otherwise wait behind a review screen, which also
 * swallows the first thing you type. Nothing at all if Codex was never here.
 */
export async function syncCodexHooks({
  enabled,
  bundledScript,
  installedScript,
  codexHome,
}: {
  enabled: boolean;
  bundledScript: string;
  installedScript: string;
  codexHome: string;
}) {
  if (!fs.existsSync(codexHome)) return;

  const settingsPath = path.join(codexHome, "hooks.json");
  syncHooks({ enabled, bundledScript, installedScript, settingsPath, events: EVENTS, isOurs });
  if (enabled) await trustHooks(hookCommand(installedScript));
}

/**
 * Trusts our hooks (only those: trust is yours to give anything else) by
 * asking Codex's own app server, which knows the hash it wants, and writes it
 * to config.toml the way it writes anything there. It's `codex` by way of a
 * login shell, where Finder's PATH wouldn't have it. Without Codex that shell
 * just exits.
 */
async function trustHooks(command: string) {
  const shell = process.env.SHELL || "/bin/zsh";
  const server = spawn(shell, ["-ilc", "exec codex app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  const waiting = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  let nextId = 0;
  let buffered = "";

  const failAll = (error: Error) => {
    for (const { reject } of waiting.values()) reject(error);
    waiting.clear();
  };
  server.on("error", failAll);
  server.on("exit", () => failAll(new Error("Codex's app server exited.")));
  server.stdin.on("error", () => {});
  const timer = setTimeout(() => {
    failAll(new Error("Codex's app server didn't answer."));
    server.kill();
  }, TIMEOUT);

  server.stdout.on("data", (data) => {
    const lines = (buffered + data).split("\n");
    buffered = lines.pop()!;
    for (const line of lines) {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // A startup file's own output.
        continue;
      }
      const call = waiting.get(message?.id);
      if (!call) continue;
      waiting.delete(message.id);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
    }
  });

  const ask = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      server.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });

  try {
    await ask("initialize", { clientInfo: { name: "miks", title: "Miks", version: "1" }, capabilities: { experimentalApi: true } });
    server.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");

    const { data } = await ask("hooks/list", { cwds: [process.env.HOME ?? "/"] });
    const edits = untrustedHooks(data, command).map((hook) => ({
      keyPath: `hooks.state."${hook.key}".trusted_hash`,
      value: hook.currentHash,
      mergeStrategy: "upsert",
    }));
    if (edits.length > 0) await ask("config/batchWrite", { edits, reloadUserConfig: false });
  } finally {
    clearTimeout(timer);
    server.kill();
  }
}

/** Of what `hooks/list` says, ours that Codex would hold back: new, or changed since trusted. */
export function untrustedHooks(entries: any[], command: string): { key: string; currentHash: string }[] {
  return entries
    .flatMap((entry) => entry?.hooks ?? [])
    .filter((hook) => hook?.source === "user" && hook.command === command)
    .filter((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified");
}
