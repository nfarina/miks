import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { tooltip } from "crosswing/modals/popup";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import type { SearchFile, SearchOptions, Tab } from "miks/shared/protocol";
import { displayPath } from "miks/shared/settings";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { FileIcon } from "./fileIcons";
import { openInPanel } from "./FileView";
import { getSettings, useSettings } from "./settings";
import { terminalScrollbarCSS } from "./TerminalView";

type Scope = "folder" | "all";
type Saved = Omit<SearchOptions, "query" | "roots"> & { scope: Scope };

const DEFAULTS: Saved = { regex: false, caseSensitive: false, wholeWord: false, everything: false, include: "", exclude: "", scope: "folder" };
const STORAGE_KEY = "SearchView:options";

function savedOptions(): Saved {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") };
  } catch {
    return DEFAULTS;
  }
}

/** A typing pause before searching: each one is a process, over a lot of files. */
const DEBOUNCE = 200;

/**
 * Find in files, on the tab's Mac: the tab's folder or all your code
 * (Settings), with ripgrep's defaults, your options kept in this window. A
 * click passes through a result; a double click, or Return, keeps it.
 */
export function SearchView({ tab, onHide }: { tab: Tab; onHide: () => void }) {
  const { searchFolders, hidePathPrefix } = useSettings();
  const home = daemon.getSnapshot().state?.home ?? null;
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState(savedOptions);
  const [more, setMore] = useState(() => !!(options.include || options.exclude));
  const [files, setFiles] = useState<SearchFile[]>([]);
  const [folded, setFolded] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<{ done: boolean; truncated?: boolean; error?: string } | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const folder = tab.cwd;

  const set = (changes: Partial<Saved>) => {
    const next = { ...options, ...changes };
    setOptions(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  };

  const roots = options.scope === "all" ? searchFolders.split(",").map((root) => root.trim()).filter(Boolean) : folder ? [folder] : [];

  useEffect(() => {
    setFiles([]);
    setFolded(new Set());
    setActive(0);
    setStatus(null);
    if (!query || roots.length === 0) return;

    let cancel = () => {};
    const timer = setTimeout(() => {
      const { scope: _, ...rest } = options;
      cancel = daemon.search({ ...rest, query, roots }, (found, end) => {
        if (found.length > 0) setFiles((current) => mergeFiles(current, found));
        if (end) setStatus({ done: true, truncated: end.truncated, error: end.error });
      });
    }, DEBOUNCE);
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [query, JSON.stringify(options), roots.join()]);

  // In order, for the arrow keys.
  const results = files.flatMap((file) => (folded.has(file.path) ? [] : file.matches.map((match) => ({ file, match }))));
  const count = files.reduce((sum, file) => sum + file.matches.length, 0);

  function open(result: (typeof results)[number], keep: boolean) {
    const { line, column, length } = result.match;
    openInPanel(tab, result.file.path, { keep, at: { line, column, length } });
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      // A first Escape in the field empties it, as in VS Code.
      if (query && (event.target as HTMLElement).hasAttribute("data-panel-focus")) setQuery("");
      else onHide();
      return;
    }
    const move = (next: number) => {
      const index = Math.max(0, Math.min(results.length - 1, next));
      setActive(index);
      listRef.current?.querySelector(`[data-result="${index}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Enter" && results[active]) open(results[active], true);
    else return;
    event.preventDefault();
  }

  const summary = status?.error
    ? status.error
    : !query
      ? null
      : count === 0
        ? status
          ? "No results."
          : "Searching…"
        : `${count.toLocaleString()} ${count === 1 ? "result" : "results"} in ${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"}${status?.truncated ? ", and it stopped there" : ""}${status ? "" : "…"}`;

  const shown = (file: string) => {
    const base = options.scope === "folder" && folder && file.startsWith(`${folder}/`) ? file.slice(folder.length + 1) : null;
    return base ?? displayPath(file, getSettings().hidePathPrefix || hidePathPrefix, home);
  };

  const positions = new Map(results.map((result, index) => [result.match, index]));

  return (
    <StyledSearchView onKeyDown={onKeyDown}>
      <div className="form">
        <div className="field">
          <input
            data-panel-focus
            value={query}
            placeholder="Find in files"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Toggle label="Aa" hint="Match case" on={options.caseSensitive} onClick={() => set({ caseSensitive: !options.caseSensitive })} />
          <Toggle label="ab" hint="Whole word" on={options.wholeWord} onClick={() => set({ wholeWord: !options.wholeWord })} underlined />
          <Toggle label=".*" hint="Regular expression" on={options.regex} onClick={() => set({ regex: !options.regex })} />
        </div>
        <div className="scope">
          <button data-on={options.scope === "folder"} onClick={() => set({ scope: "folder" })}>
            This folder
          </button>
          <button
            data-on={options.scope === "all"}
            onClick={() => set({ scope: "all" })}
            {...tooltip(displayPathList(searchFolders), { delay: true, placement: "below" })}
          >
            All code
          </button>
          <span className="spacer" />
          <button className="more" data-on={more} onClick={() => setMore(!more)} {...tooltip("Files to include or exclude", { delay: true, placement: "below" })}>
            <SlidersHorizontal />
          </button>
        </div>
        {more && (
          <div className="globs">
            <input value={options.include} placeholder="Include, like src/**, *.ts" spellCheck={false} onChange={(event) => set({ include: event.target.value })} />
            <input value={options.exclude} placeholder="Exclude, like dist, *.lock" spellCheck={false} onChange={(event) => set({ exclude: event.target.value })} />
            <label>
              <input type="checkbox" checked={options.everything} onChange={() => set({ everything: !options.everything })} />
              Search ignored and hidden files too
            </label>
          </div>
        )}
      </div>
      {summary && <div className="summary" data-error={!!status?.error}>{summary}</div>}
      <div className="results" ref={listRef}>
        {files.map((file) => (
          <div key={file.path} className="file">
            <div
              className="name"
              onClick={() => {
                const next = new Set(folded);
                if (!next.delete(file.path)) next.add(file.path);
                setFolded(next);
              }}
            >
              <ChevronRight data-open={!folded.has(file.path)} />
              <FileIcon name={file.path.split("/").pop()!} />
              <span className="base">{file.path.split("/").pop()}</span>
              <span className="folder">{shown(file.path).replace(/\/?[^/]*$/, "")}</span>
              <span className="count">{file.matches.length}</span>
            </div>
            {!folded.has(file.path) &&
              file.matches.map((match) => {
                const at = positions.get(match);
                return (
                  <div
                    key={`${match.line}:${match.column}`}
                    className="match"
                    data-result={at}
                    data-active={at === active}
                    onClick={() => {
                      setActive(at ?? 0);
                      open({ file, match }, false);
                    }}
                    onDoubleClick={() => open({ file, match }, true)}
                  >
                    <span className="line">{match.line}</span>
                    <span className="text">{highlighted(match.text, match.ranges)}</span>
                  </div>
                );
              })}
          </div>
        ))}
      </div>
    </StyledSearchView>
  );
}

const displayPathList = (folders: string) => `Searches ${folders}. Change it in Settings → Advanced.`;

/** Results as they arrive: a file sent in two batches stays one entry. */
function mergeFiles(current: SearchFile[], found: SearchFile[]): SearchFile[] {
  const next = [...current];
  for (const file of found) {
    const index = next.findIndex((other) => other.path === file.path);
    if (index === -1) next.push(file);
    else next[index] = { ...next[index], matches: [...next[index].matches, ...file.matches] };
  }
  return next;
}

function highlighted(text: string, ranges: [number, number][]): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of ranges) {
    if (from > at) parts.push(text.slice(at, from));
    parts.push(<mark key={from}>{text.slice(from, to)}</mark>);
    at = to;
  }
  parts.push(text.slice(at));
  return parts;
}

function Toggle({ label, hint, on, underlined, onClick }: { label: string; hint: string; on: boolean; underlined?: boolean; onClick: () => void }) {
  return (
    <button type="button" className="toggle" data-on={on} data-underlined={underlined} onClick={onClick} {...tooltip(hint, { delay: true, placement: "below" })}>
      {label}
    </button>
  );
}

const StyledSearchView = styled.div`
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-flow: column;

  > .form {
    flex-shrink: 0;
    display: flex;
    flex-flow: column;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid ${colors.separator()};

    input:not([type="checkbox"]) {
      min-width: 0;
      border: none;
      outline: none;
      background: none;
      color: ${colors.text()};
      font: ${fonts.display({ size: 13, line: "20px" })};
    }

    > .field,
    > .globs > input:not([type="checkbox"]) {
      border-radius: 6px;
      background: ${colors.textBackground()};
      box-shadow: inset 0 0 0 1px ${colors.separator()};
    }

    > .field {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 3px 4px 3px 8px;

      &:focus-within {
        box-shadow: inset 0 0 0 1px ${colors.turquoise()};
      }

      > input {
        flex: 1;
      }
    }

    .toggle {
      flex-shrink: 0;
      width: 24px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: none;
      color: ${colors.textSecondary()};
      font: ${fonts.displayMono({ size: 11, line: "22px" })};
      cursor: pointer;

      &[data-underlined="true"] {
        text-decoration: underline;
      }

      &[data-on="true"] {
        background: ${colors.turquoise()};
        color: #fff;
      }
    }

    > .scope {
      display: flex;
      align-items: center;
      gap: 4px;

      > .spacer {
        flex: 1;
      }

      > button {
        height: 24px;
        padding: 0 8px;
        display: flex;
        align-items: center;
        border: none;
        border-radius: 6px;
        background: none;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 12, line: "24px" })};
        cursor: pointer;

        &[data-on="true"] {
          background: ${colors.buttonBackgroundGlow()};
          color: ${colors.text()};
        }

        > svg {
          width: 14px;
          height: 14px;
        }
      }
    }

    > .globs {
      display: flex;
      flex-flow: column;
      gap: 6px;

      > input:not([type="checkbox"]) {
        padding: 3px 8px;
      }

      > label {
        display: flex;
        align-items: center;
        gap: 6px;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 12, line: "20px" })};
      }
    }
  }

  > .summary {
    flex-shrink: 0;
    padding: 6px 12px;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 12, line: "18px" })};

    &[data-error="true"] {
      color: ${colors.red()};
    }
  }

  > .results {
    flex-grow: 1;
    min-height: 0;
    overflow: auto;
    padding-bottom: 12px;
    ${terminalScrollbarCSS}
  }

  > .results > .file {
    /* Thousands of rows, nearly all off screen. */
    content-visibility: auto;
    contain-intrinsic-height: auto 60px;

    > .name {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 24px;
      padding: 0 10px 0 6px;
      background: ${colors.textBackgroundPanel()};
      font: ${fonts.display({ size: 13, line: "24px" })};
      white-space: nowrap;
      cursor: default;
      -webkit-user-select: none;
      user-select: none;

      > svg {
        flex-shrink: 0;
        width: 13px;
        height: 13px;
        color: ${colors.textSecondary()};
        transition: transform 0.1s;

        &[data-open="true"] {
          transform: rotate(90deg);
        }
      }

      > .base {
        flex-shrink: 0;
        max-width: 70%;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      > .folder {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        color: ${colors.textSecondary()};
        font-size: 12px;
      }

      > .count {
        flex-shrink: 0;
        color: ${colors.textSecondary()};
        font-size: 11px;
      }
    }

    > .match {
      display: flex;
      gap: 8px;
      padding: 0 10px 0 24px;
      font: ${fonts.displayMono({ size: 12, line: "21px" })};
      white-space: nowrap;
      cursor: default;

      @media (pointer: coarse) {
        font: ${fonts.displayMono({ size: 12, line: "30px" })};
      }

      &:hover,
      &[data-active="true"] {
        background: ${colors.buttonBackgroundGlow()};
      }

      > .line {
        flex-shrink: 0;
        min-width: 3ch;
        text-align: right;
        color: ${colors.textSecondary()};
      }

      > .text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;

        > mark {
          border-radius: 2px;
          background: ${colors.yellow({ alpha: 0.4 })};
          color: inherit;
        }
      }
    }
  }
`;
