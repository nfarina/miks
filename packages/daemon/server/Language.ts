import { type ChildProcess, execFile, spawn } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { Definition } from "../shared/protocol.ts";
import { repoRoot } from "./Search.ts";

/** TypeScript 7's own compiler, the bundle's as the repo's: it answers for JavaScript too. */
const TYPESCRIPT = path.resolve(import.meta.dirname, "../../../node_modules/@typescript/typescript-darwin-arm64/lib/tsc");

/** Language servers: anything speaking LSP over stdio goes here. */
const LANGUAGES = [
  {
    name: "TypeScript",
    files: /\.[cm]?[jt]sx?$/i,
    command: TYPESCRIPT,
    args: ["--lsp", "--stdio"],
    id: (file: string) => {
      const typed = /\.[cm]?tsx?$/i.test(file) ? "typescript" : "javascript";
      return /x$/i.test(file) ? `${typed}react` : typed;
    },
  },
];
type Language = (typeof LANGUAGES)[number];

/**
 * These servers' memory only grows (Denada's passed 2 GB in a stress test, and
 * didn't come back idle) and starting one takes under a second, so none stays
 * running: each stops this long after it was last asked anything.
 */
const IDLE = 5 * 60_000;
/** Or past this, however busy. Above what a big repo takes just to load. */
const MAX_MEMORY_KB = 3 * 1024 * 1024;
const TIMEOUT = 30_000;

/** A running server, for one language in one repo. */
class Server {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, { resolve: (result: any) => void; reject: (error: Error) => void }>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private idle?: NodeJS.Timeout;
  /** The file it has from us, as the editor has it. Others it reads from disk each time. */
  private open: { uri: string; version: number; text: string } | null = null;
  readonly started: Promise<unknown>;

  private readonly language: Language;
  private readonly onStop: () => void;

  constructor(language: Language, root: string, onStop: () => void) {
    this.language = language;
    this.onStop = onStop;
    this.child = spawn(language.command, language.args, { cwd: root, stdio: ["pipe", "pipe", "ignore"] });
    this.child.stdin!.on("error", () => {});
    this.child.stdout!.on("data", (data: Buffer) => this.receive(data));
    this.child.on("error", (error) => this.ended(error));
    this.child.on("exit", () => this.ended(new Error(`${language.name}'s language server stopped.`)));

    // Saying nothing of `workspace.didChangeWatchedFiles`: it then finds changes
    // on disk by itself, within 300ms, so what agents write counts.
    const uri = pathToFileURL(root).href;
    this.started = this.request("initialize", {
      processId: process.pid,
      rootUri: uri,
      capabilities: { textDocument: { definition: { linkSupport: true } } },
      workspaceFolders: [{ uri, name: path.basename(root) }],
    }).then(() => this.notify("initialized", {}));
    // A failure here is the first request's to report.
    this.started.catch(() => {});
    this.touch();
  }

  /** Where the thing at this position in `file` is defined. */
  async definition(file: string, text: string, line: number, character: number): Promise<Definition | null> {
    await this.started;
    this.touch();
    this.show(file, text);
    const found = await this.request("textDocument/definition", {
      textDocument: { uri: this.open!.uri },
      position: { line, character },
    });
    const first = Array.isArray(found) ? found[0] : found;
    const uri: string | undefined = first?.targetUri ?? first?.uri;
    const range = first?.targetSelectionRange ?? first?.range;
    if (!uri || !range) return null;
    const { start, end } = range;
    return {
      path: fileURLToPath(uri),
      line: start.line + 1,
      column: start.character,
      length: end.line === start.line ? end.character - start.character : 0,
    };
  }

  /** Stops it if it's grown too big, now that it's answered. */
  checkMemory() {
    const pid = this.child.pid;
    if (pid === undefined) return;
    execFile("ps", ["-o", "rss=", "-p", String(pid)], (error, stdout) => {
      if (!error && Number(stdout) > MAX_MEMORY_KB) this.stop();
    });
  }

  stop() {
    this.child.kill();
    this.ended(new Error(`${this.language.name}'s language server stopped.`));
  }

  /** Hands it the editor's text, which needn't be saved. One file at a time: a chain of jumps leaves nothing open behind it. */
  private show(file: string, text: string) {
    const uri = pathToFileURL(file).href;
    if (this.open?.uri === uri) {
      if (this.open.text === text) return;
      this.open.text = text;
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: ++this.open.version },
        contentChanges: [{ text }],
      });
      return;
    }
    const before = this.open;
    this.open = { uri, version: 1, text };
    // In this order: with nothing open, it can drop the project.
    this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.language.id(file), version: 1, text } });
    if (before) this.notify("textDocument/didClose", { textDocument: { uri: before.uri } });
  }

  private touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), IDLE);
    this.idle.unref();
  }

  private ended(error: Error) {
    clearTimeout(this.idle);
    this.onStop();
    for (const { reject } of this.waiting.values()) reject(error);
    this.waiting.clear();
  }

  private write(message: object) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }));
    this.child.stdin!.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin!.write(body);
  }

  private notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.language.name}'s language server took too long.`));
        this.stop();
      }, TIMEOUT);
      this.waiting.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.write({ id, method, params });
    });
  }

  private receive(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.toString("utf8", 0, end))?.[1] ?? 0);
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.toString("utf8", end + 4, end + 4 + length));
      this.buffer = this.buffer.subarray(end + 4 + length);

      if (message.method && message.id !== undefined) {
        // It waits on an answer to anything it asks, and no answer is fine.
        const result = message.method === "workspace/configuration" ? message.params.items.map(() => null) : null;
        this.write({ id: message.id, result });
      } else if (message.id !== undefined) {
        const waiting = this.waiting.get(message.id);
        this.waiting.delete(message.id);
        if (message.error) waiting?.reject(new Error(message.error.message));
        else waiting?.resolve(message.result);
      }
    }
  }
}

const servers = new Map<string, Server>();

/**
 * Where the symbol at `line` (from 1) and `column` of a file is defined, or
 * null if nowhere. `text` is the file as its editor has it. Starts the file's
 * language server if it isn't running.
 */
export async function findDefinition(file: string, text: string, line: number, column: number): Promise<Definition | null> {
  const language = LANGUAGES.find(({ files }) => files.test(file));
  if (!language) return null;
  const folder = path.dirname(file);
  const root = repoRoot(folder) ?? folder;
  const key = `${language.name}:${root}`;
  let server = servers.get(key);
  if (!server) {
    server = new Server(language, root, () => {
      if (servers.get(key) === server) servers.delete(key);
    });
    servers.set(key, server);
  }
  const found = await server.definition(file, text, line - 1, column);
  server.checkMemory();
  return found;
}

/** Nothing depends on this: a server exits as its stdin closes, the daemon dying included. */
export function stopLanguageServers() {
  for (const server of servers.values()) server.stop();
}
