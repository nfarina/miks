// The grok hooks behind each tab's agent status: a file of our own in
// ~/.grok/hooks, where grok merges every file's. grok runs Claude Code's
// hooks too, which claude-hook.sh sits out (GROK_HOOK_EVENT). The script is a
// no-op outside Miks.
import fs from "fs";
import path from "path";
import { hookCommand } from "./claudeHooks.ts";

const EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "Stop",
  "StopCancelled",
  "StopFailure",
  "SessionEnd",
];

/** Writes or removes our file, unless grok was never here. */
export function syncGrokHooks({
  enabled,
  bundledScript,
  installedScript,
  grokHome,
}: {
  enabled: boolean;
  bundledScript: string;
  installedScript: string;
  grokHome: string;
}) {
  if (!fs.existsSync(grokHome)) return;
  const file = path.join(grokHome, "hooks/miks.json");

  if (!enabled) {
    fs.rmSync(file, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(installedScript), { recursive: true, mode: 0o700 });
  const script = fs.readFileSync(bundledScript, "utf8");
  if (readOrNull(installedScript) !== script) fs.writeFileSync(installedScript, script, { mode: 0o755 });

  const group = [{ hooks: [{ type: "command", command: hookCommand(installedScript) }] }];
  const text = JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((event) => [event, group])) }, null, 2) + "\n";
  if (readOrNull(file) === text) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
