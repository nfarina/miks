import fs from "fs";
import os from "os";
import path from "path";
import type { FileProblem } from "../shared/protocol.ts";

/** The most the panel opens: past this it's a log or a dump, not a file to edit. */
const MAX_SIZE = 5 * 1024 * 1024;

/** What the panel shows of a file: its text, or why there's none to show. */
export type FileContents = { content: string | null; mtime: number | null; problem?: FileProblem };

/** A file for the panel. One that isn't there yet is empty, with no mtime. */
export async function readForPanel(file: string): Promise<FileContents> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { content: "", mtime: null };
    return { content: null, mtime: null, problem: "unreadable" };
  }
  if (!stat.isFile()) return { content: null, mtime: stat.mtimeMs, problem: "unreadable" };
  if (stat.size > MAX_SIZE) return { content: null, mtime: stat.mtimeMs, problem: "large" };

  let data: Buffer;
  try {
    data = await fs.promises.readFile(file);
  } catch {
    return { content: null, mtime: stat.mtimeMs, problem: "unreadable" };
  }
  // A NUL byte early on is as good a sign of binary as any (git uses it).
  if (data.subarray(0, 8000).includes(0)) return { content: null, mtime: stat.mtimeMs, problem: "binary" };
  return { content: data.toString("utf8"), mtime: stat.mtimeMs };
}

/**
 * Saves a file from the panel, in place (keeping its permissions and any
 * hard links), unless it changed on disk since the editor's copy: then it's
 * left alone and `changed` says so, for the editor to ask.
 */
export async function writeFromPanel(
  file: string,
  content: string,
  mtime: number | null,
  force = false,
): Promise<{ mtime?: number; changed?: boolean; error?: string }> {
  if (!force) {
    const current = await fs.promises.stat(file).then(
      (stat) => stat.mtimeMs,
      () => null,
    );
    if (current !== mtime) return { changed: true };
  }

  try {
    await fs.promises.writeFile(file, content);
    return { mtime: (await fs.promises.stat(file)).mtimeMs };
  } catch (error: any) {
    return { error: String(error?.message ?? error) };
  }
}

/** The most a markdown file's image can be: they go to the window base64. */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** What a markdown file in the panel can show as an image, by extension. */
const IMAGE_TYPES: Record<string, string> = {
  apng: "image/apng",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
};

/**
 * An image for a markdown file in the panel, base64. Only images, by
 * extension: a file's `![](~/.ssh/id_ed25519)` gets nothing.
 */
export async function readImageForPanel(file: string): Promise<{ data?: string; mime?: string; error?: string }> {
  const mime = IMAGE_TYPES[file.split(".").pop()?.toLowerCase() ?? ""];
  if (!mime) return { error: "Not an image." };

  try {
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) return { error: "Not a file." };
    if (stat.size > MAX_IMAGE_SIZE) return { error: "Too big to show (over 10 MB)." };
    return { data: (await fs.promises.readFile(file)).toString("base64"), mime };
  } catch (error: any) {
    return { error: error?.code === "ENOENT" ? "No such file." : "Can't be read." };
  }
}

/**
 * Paths as a terminal shows them, found on disk: relative to `cwd`, `~` the
 * home folder, and with any `:line` or `:line:column` after a file's name
 * (compilers', and Claude Code's, way of pointing into it) left off.
 */
export async function findPaths(paths: string[], cwd: string | null): Promise<({ path: string; folder: boolean } | null)[]> {
  const find = async (written: string) => {
    const expanded = written === "~" || written.startsWith("~/") ? os.homedir() + written.slice(1) : written;
    if (!path.isAbsolute(expanded) && !cwd) return null;
    const absolute = path.resolve(cwd ?? "/", expanded);
    try {
      const stat = await fs.promises.stat(absolute);
      return stat.isDirectory() || stat.isFile() ? { path: absolute, folder: stat.isDirectory() } : null;
    } catch {
      return null;
    }
  };
  return Promise.all(
    paths.map(async (written) => {
      const found = await find(written);
      if (found) return found;
      const bare = written.replace(/(:\d+){1,2}$/, "");
      return bare !== written ? find(bare) : null;
    }),
  );
}
