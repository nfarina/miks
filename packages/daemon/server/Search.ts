import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import type { FolderEntry, SearchFile, SearchOptions } from "../shared/protocol.ts";

/** Bundled (scripts/ripgrep.ts), or else whatever's on PATH. */
const BUNDLED = path.resolve(import.meta.dirname, "../ripgrep/build/rg");
const ripgrep = () => (fs.existsSync(BUNDLED) ? BUNDLED : "rg");

/** Where a search stops: past this, more results are no use to anyone. */
const MAX_MATCHES = 5000;
/** A line's text is cut to about this around its first match (minified files have very long ones). */
const MAX_LINE = 300;
/** ⌘P filters these in the window. */
const MAX_FILES = 50_000;
const SEND_EVERY = 60;

/** Never searched unless you ask for ignored files: repos often forget to ignore them, and folders that aren't repos have no `.gitignore`. */
const SKIP = ["!node_modules", "!.git"];

const expand = (folder: string) => (folder === "~" || folder.startsWith("~/") ? os.homedir() + folder.slice(1) : folder);

const globs = (list: string) =>
  list
    .split(",")
    .map((glob) => glob.trim())
    .filter(Boolean);

/** Offsets into `line` of a match's bytes: ripgrep counts bytes, and strings count UTF-16 units. */
function charOffset(line: Buffer, byte: number) {
  return line.subarray(0, byte).toString("utf8").length;
}

/** A line of ripgrep's JSON as a match, its text cut down to around the first hit. */
function parseMatch(data: any): SearchFile["matches"][number] | null {
  const text: string | undefined = data.lines?.text;
  if (text === undefined || !data.submatches?.length) return null;
  const whole = text.replace(/\r?\n$/, "");
  const bytes = Buffer.from(whole);
  const spans: [number, number][] = data.submatches.map((sub: { start: number; end: number }) => [charOffset(bytes, sub.start), charOffset(bytes, sub.end)]);
  const column = spans[0][0];
  const length = spans[0][1] - column;
  // The indent says nothing here, and costs a narrow panel the words.
  let start = whole.length - whole.trimStart().length;
  if (column - start > 60) start = column - 40;
  const end = Math.min(whole.length, start + MAX_LINE);
  const ranges = spans.filter(([from]) => from >= start && from < end).map(([from, to]): [number, number] => [from - start, Math.min(to, end) - start]);
  return { line: data.line_number, column, length, text: whole.slice(start, end), ranges };
}

/**
 * Searches folders with ripgrep, sending what it's found every so often, the
 * last time with `done`. Returns what stops it.
 */
export function searchFiles(
  options: SearchOptions,
  send: (files: SearchFile[], end?: { done: true; truncated?: boolean; error?: string }) => void,
): () => void {
  const roots = options.roots.map(expand).filter((root) => path.isAbsolute(root) && fs.existsSync(root));
  if (roots.length === 0) {
    send([], { done: true, error: "None of these folders are there." });
    return () => {};
  }

  const args = ["--json", "--no-config", "--no-messages", "--max-filesize", "5M"];
  if (!options.regex) args.push("--fixed-strings");
  if (!options.caseSensitive) args.push("--ignore-case");
  if (options.wholeWord) args.push("--word-regexp");
  if (options.everything) args.push("--no-ignore", "--hidden");
  for (const glob of globs(options.include)) args.push("--glob", glob);
  for (const glob of globs(options.exclude)) args.push("--glob", `!${glob.replace(/^!/, "")}`);
  if (!options.everything) for (const glob of SKIP) args.push("--glob", glob);
  args.push("--regexp", options.query, "--", ...roots);

  const child = spawn(ripgrep(), args, { stdio: ["ignore", "pipe", "pipe"] });
  const files = new Map<string, SearchFile>();
  let total = 0;
  let truncated = false;
  let stopped = false;
  let rest = "";
  let errors = "";

  const flush = () => {
    if (files.size === 0) return;
    send([...files.values()]);
    files.clear();
  };
  const timer = setInterval(flush, SEND_EVERY);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    child.kill();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop()!;
    for (const line of lines) {
      if (truncated || !line.includes('"type":"match"')) continue;
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type !== "match") continue;
      const file: string | undefined = event.data.path?.text;
      const match = parseMatch(event.data);
      if (!file || !match) continue;
      const entry = files.get(file) ?? { path: file, matches: [] };
      files.set(file, entry);
      entry.matches.push(match);
      if (++total >= MAX_MATCHES) {
        truncated = true;
        child.kill();
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (errors += chunk));

  const end = (error?: string) => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    flush();
    send([], { done: true, truncated, error });
  };
  child.on("error", (error) => end(`Couldn't run ripgrep: ${error.message}`));
  // Exits 1 for no matches, 2 for an error (a bad regex); with `--no-messages`, not a file it can't read.
  child.on("close", (code) => end(code === 2 && total === 0 ? errors.trim().split("\n").slice(-1)[0] || "The search failed." : undefined));
  return stop;
}

/** The folder a path's repo starts at, if it's in one. */
function repoRoot(folder: string): string | null {
  for (let at = folder; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    if (at === path.dirname(at)) return null;
  }
}

/** Every file ripgrep would search under `folder`'s repo (or `folder`, outside one), for ⌘P. */
export function listFiles(folder: string): Promise<{ root: string; paths: string[]; truncated: boolean }> {
  const root = repoRoot(folder) ?? folder;
  return new Promise((resolve) => {
    const child = spawn(ripgrep(), ["--files", "--no-config", "--no-messages", ...SKIP.flatMap((glob) => ["--glob", glob])], {
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths: string[] = [];
    let rest = "";
    let truncated = false;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop()!;
      paths.push(...lines);
      if (paths.length >= MAX_FILES) {
        truncated = true;
        child.kill();
      }
    });
    child.on("error", () => resolve({ root, paths: [], truncated: false }));
    child.on("close", () => resolve({ root, paths: paths.slice(0, MAX_FILES), truncated }));
  });
}

/** Which of a folder's entries its repo ignores: none, outside one. */
function ignoredIn(folder: string, entries: FolderEntry[]): Promise<Set<string>> {
  if (entries.length === 0 || !repoRoot(folder)) return Promise.resolve(new Set());
  return new Promise((resolve) => {
    const child = execFile("git", ["-C", folder, "check-ignore", "--stdin", "-z"], { timeout: 3000, maxBuffer: 1 << 22 }, (_error, stdout) => {
      // It exits 1 when none are, so whatever it printed is the answer.
      resolve(new Set(stdout.split("\0").filter(Boolean).map((name) => name.replace(/\/$/, ""))));
    });
    child.stdin?.on("error", () => {});
    // With the slash, for patterns only folders match (`dist/`).
    child.stdin?.end(entries.map((entry) => (entry.folder ? `${entry.name}/` : entry.name)).join("\0"));
  });
}

/** A folder's entries, folders first, as a file browser lists them. */
export async function readFolder(folder: string): Promise<FolderEntry[]> {
  const found = await fs.promises.readdir(folder, { withFileTypes: true });
  const entries = await Promise.all(
    found
      .filter((entry) => entry.name !== ".git" && entry.name !== ".DS_Store")
      .map(async (entry): Promise<FolderEntry | null> => {
        // A link counts as what it points at; a broken one isn't listed.
        if (!entry.isSymbolicLink()) return entry.isDirectory() || entry.isFile() ? { name: entry.name, folder: entry.isDirectory() } : null;
        try {
          return { name: entry.name, folder: (await fs.promises.stat(path.join(folder, entry.name))).isDirectory() };
        } catch {
          return null;
        }
      }),
  );
  const listed = entries.filter((entry) => entry !== null);
  const ignored = await ignoredIn(folder, listed);
  return listed
    .map((entry) => (ignored.has(entry.name) ? { ...entry, ignored: true } : entry))
    .sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}
