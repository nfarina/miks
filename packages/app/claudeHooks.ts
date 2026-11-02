// The Claude Code hooks behind each tab's agent status: one command, for
// every event Workspaces.applyHook reads, in ~/.claude/settings.json. The
// script is a no-op outside Miks, so having it global costs nothing.
import fs from "fs";
import path from "path";

const EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "Stop", "SessionEnd"];

/** Ours, wherever it was installed from (older setups pointed into the repo). */
const isOurs = (hook: any) =>
  typeof hook?.command === "string" && /miks/i.test(hook.command) && /claude-hook\.sh'?$/.test(hook.command);

/** Claude Code runs hooks through a shell, and Application Support has a space. */
export const hookCommand = (script: string) => `'${script.replaceAll("'", "'\\''")}'`;

/**
 * Adds or removes our hooks, touching nothing else in Claude's settings. The
 * hooks run a copy of the script in Miks's own folder rather than the one in
 * the app, so their path is the same for the dev build and Miks.app, and
 * survives updates.
 */
export function syncClaudeHooks({
  enabled,
  bundledScript,
  installedScript,
  claudeSettingsPath,
}: {
  enabled: boolean;
  bundledScript: string;
  installedScript: string;
  claudeSettingsPath: string;
}) {
  syncHooks({ enabled, bundledScript, installedScript, settingsPath: claudeSettingsPath, events: EVENTS, isOurs });
}

/**
 * The same for any agent whose settings hold hooks as Claude Code's do, in a
 * JSON file's `hooks`.
 */
export function syncHooks({
  enabled,
  bundledScript,
  installedScript,
  settingsPath,
  events,
  isOurs,
}: {
  enabled: boolean;
  bundledScript: string;
  installedScript: string;
  settingsPath: string;
  events: string[];
  isOurs: (hook: any) => boolean;
}) {
  if (enabled) {
    fs.mkdirSync(path.dirname(installedScript), { recursive: true, mode: 0o700 });
    const script = fs.readFileSync(bundledScript, "utf8");
    if (readOrNull(installedScript) !== script) fs.writeFileSync(installedScript, script, { mode: 0o755 });
  }

  const text = readOrNull(settingsPath);
  let settings: any = {};
  if (text !== null) {
    try {
      settings = JSON.parse(text);
    } catch {
      // Not ours to fix; leave it alone rather than overwrite it.
      return;
    }
  }

  const hooks: Record<string, any[]> = { ...settings.hooks };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((group) => (Array.isArray(group?.hooks) ? { ...group, hooks: group.hooks.filter((h: any) => !isOurs(h)) } : group))
      .filter((group) => !Array.isArray(group?.hooks) || group.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (enabled) {
    for (const event of events) {
      hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command: hookCommand(installedScript) }] }];
    }
  }

  const next = { ...settings, hooks };
  if (Object.keys(hooks).length === 0) delete next.hooks;
  const updated = JSON.stringify(next, null, 2) + "\n";
  if (text !== null && JSON.stringify(JSON.parse(text)) === JSON.stringify(next)) return;
  if (text === null && !enabled) return;

  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.miks.tmp`;
  fs.writeFileSync(temporary, updated);
  fs.renameSync(temporary, settingsPath);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
