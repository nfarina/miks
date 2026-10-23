// ⌘-click a path in a terminal, as in cmux: a markdown file opens in the
// tab's panel, a folder in Finder. Only paths that are there on the tab's
// Mac (the daemon looks, relative to the tab's folder) are links, and only
// underlined while ⌘ is down; a plain click still selects.
import type { IDisposable, ILink, Terminal } from "@xterm/xterm";
import { daemon, type FoundPath, isRemote } from "./daemon";
import { isMarkdown } from "./markdown";

/** What could be a path: a run of anything but spaces, quotes, brackets and markdown's `*`. */
const TOKEN = /[^\s'"`()[\]{}<>|;,*]+/g;

/** How long a lookup holds: files come and go, but not as you move the mouse. */
const FRESH_MS = 3000;

export function handlePathLinks(terminal: Terminal, tabId: string): IDisposable {
  const lookups = new Map<string, { at: number; found: Promise<FoundPath> }>();
  let hovered: ILink | null = null;

  function find(tokens: string[]): Promise<FoundPath[]> {
    const now = Date.now();
    const missing = tokens.filter((token) => !((lookups.get(token)?.at ?? 0) > now - FRESH_MS));
    if (missing.length > 0) {
      const found = daemon.findPaths(tabId, missing);
      missing.forEach((token, index) => lookups.set(token, { at: now, found: found.then((all) => all[index] ?? null) }));
    }
    return Promise.all(tokens.map((token) => lookups.get(token)!.found));
  }

  const provider = terminal.registerLinkProvider({
    provideLinks(y, callback) {
      const line = logicalLine(terminal, y - 1);
      const tokens = [...line.text.matchAll(TOKEN)]
        .map((match) => ({ text: match[0].replace(/[.,:;!?]+$/, ""), index: match.index }))
        .filter(({ text, index }) => {
          if (!isPathLike(text)) return false;
          // Only those on (or wrapping through) the line asked about.
          const first = line.cells[index];
          const last = line.cells[index + text.length - 1];
          return first && last && first.y <= y - 1 && last.y >= y - 1;
        });
      if (tokens.length === 0) return callback(undefined);

      void find(tokens.map(({ text }) => text)).then((found) => {
        const links: ILink[] = [];
        tokens.forEach(({ text, index }, i) => {
          const path = found[i];
          if (!path || !(path.folder ? !isRemote() : isMarkdown(path.path))) return;
          const first = line.cells[index];
          const last = line.cells[index + text.length - 1];
          const link: ILink = {
            text,
            range: { start: { x: first.x + 1, y: first.y + 1 }, end: { x: last.x + 1, y: last.y + 1 } },
            decorations: { underline: false, pointerCursor: false },
            hover: (event) => {
              hovered = link;
              // Once xterm.js has made its own decorations to follow, just after this.
              queueMicrotask(() => decorate(link, event.metaKey));
            },
            leave: () => {
              if (hovered === link) hovered = null;
            },
            activate: (event) => {
              if (!event.metaKey) return;
              if (path.folder) daemon.send({ type: "showFolder", path: path.path });
              else daemon.send({ type: "openFile", tabId, path: path.path });
            },
          };
          links.push(link);
        });
        callback(links.length > 0 ? links : undefined);
      });
    },
  });

  // ⌘ going down or up with the mouse already on a path.
  const onKey = (event: KeyboardEvent) => {
    if (hovered && event.key === "Meta") decorate(hovered, event.type === "keydown");
  };
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("keyup", onKey, true);

  return {
    dispose() {
      provider.dispose();
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("keyup", onKey, true);
    },
  };
}

/** Shows a link as one only while ⌘ is down (xterm.js redraws as these change). */
function decorate(link: ILink, command: boolean) {
  if (!link.decorations) return;
  link.decorations.underline = command;
  link.decorations.pointerCursor = command;
}

/**
 * Worth asking the daemon about: absolute, from `~`, `./` or `../`, with a
 * folder in it (`src/notes.md`), or a markdown file's name on its own. Not
 * URLs, which are links already.
 */
function isPathLike(text: string): boolean {
  if (text.length < 2 || text.includes("://")) return false;
  if (/^(\/|~\/|\.\.?\/)/.test(text) || text.includes("/")) return true;
  return isMarkdown(text.replace(/(:\d+){1,2}$/, ""));
}

/**
 * The whole line a buffer row is part of, wrapped rows joined, and the cell
 * each of its characters is in (wide ones take two cells, one character).
 */
function logicalLine(terminal: Terminal, row: number): { text: string; cells: { x: number; y: number }[] } {
  const buffer = terminal.buffer.active;
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--;
  let end = row;
  while (buffer.getLine(end + 1)?.isWrapped) end++;

  let text = "";
  const cells: { x: number; y: number }[] = [];
  for (let y = start; y <= end; y++) {
    const line = buffer.getLine(y);
    if (!line) break;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      if (!cell || cell.getWidth() === 0) continue;
      const chars = cell.getChars() || " ";
      text += chars;
      for (let i = 0; i < chars.length; i++) cells.push({ x, y });
    }
  }
  return { text, cells };
}
