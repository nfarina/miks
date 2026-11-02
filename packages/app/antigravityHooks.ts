// The Antigravity hooks behind each tab's agent status, in
// ~/.gemini/config/hooks.json, under a name of our own: it holds named hooks,
// not Claude Code's lists. The script is a no-op outside Miks.
import fs from "fs";
import path from "path";
import { hookCommand } from "./claudeHooks.ts";

/** Whose it is in the file. Antigravity merges every name's hooks. */
const NAME = "miks";

/**
 * Adds or removes our hooks, touching nothing else in the file, unless
 * Antigravity was never here. `PreToolUse` is left out on purpose: its answer
 * is a permission decision, and ours would be one.
 */
export function syncAntigravityHooks({
  enabled,
  bundledScript,
  installedScript,
  geminiHome,
}: {
  enabled: boolean;
  bundledScript: string;
  installedScript: string;
  geminiHome: string;
}) {
  if (!fs.existsSync(geminiHome)) return;

  const file = path.join(geminiHome, "config/hooks.json");
  const text = readOrNull(file);
  let hooks: any = {};
  if (text?.trim()) {
    try {
      hooks = JSON.parse(text);
    } catch {
      // Not ours to fix.
      return;
    }
  }

  const next = { ...hooks };
  delete next[NAME];
  if (enabled) {
    fs.mkdirSync(path.dirname(installedScript), { recursive: true, mode: 0o700 });
    const script = fs.readFileSync(bundledScript, "utf8");
    if (readOrNull(installedScript) !== script) fs.writeFileSync(installedScript, script, { mode: 0o755 });

    const handler = { type: "command", command: hookCommand(installedScript) };
    next[NAME] = {
      SessionStart: [handler],
      PreInvocation: [handler],
      PostToolUse: [{ matcher: "*", hooks: [handler] }],
      Stop: [handler],
    };
  }

  if (JSON.stringify(next) === JSON.stringify(hooks)) return;
  if (text === null && !enabled) return;

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.miks.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
