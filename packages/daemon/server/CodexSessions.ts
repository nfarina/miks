import fs from "fs";
import os from "os";
import path from "path";

/**
 * The session a Codex title names, for one resumed with no hook to say so:
 * they wait for the first prompt, and `codex resume`'s picker leaves no ID in
 * its arguments and no rollout open. The title is `<spinner> <thread> |
 * <project>`, and `session_index.jsonl` appends each thread's latest name.
 */
export function findCodexSession(
  title: string,
  home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
): { id: string; transcriptPath?: string } | undefined {
  const name = threadName(title);
  if (!name) return;

  let index: string;
  try {
    index = fs.readFileSync(path.join(home, "session_index.jsonl"), "utf8");
  } catch {
    return;
  }

  // The latest first: a name can be reused, and only the newest can be meant.
  for (const line of index.split("\n").reverse()) {
    if (!line.includes(name)) continue;
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.thread_name !== name || typeof record.id !== "string" || !/^[\w-]+$/.test(record.id)) continue;
    return { id: record.id, transcriptPath: rolloutPath(home, record.id) };
  }
}

function threadName(title: string): string | undefined {
  const separator = title.lastIndexOf(" | ");
  if (separator < 0) return;
  return title.slice(0, separator).replace(/^[⠀-⣿]\s+/u, "") || undefined;
}

/** Its live rollout; compressed ones aren't followed, until a hook names what resuming writes to. */
function rolloutPath(home: string, id: string): string | undefined {
  try {
    const [found] = fs.globSync(`sessions/**/rollout-*-${id}.jsonl`, { cwd: home });
    return found ? path.join(home, found) : undefined;
  } catch {
    return;
  }
}
