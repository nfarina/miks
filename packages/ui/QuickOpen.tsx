import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { tooltip } from "crosswing/modals/popup";
import type { Tab } from "miks/shared/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { FileIcon } from "./fileIcons";
import { fitScore } from "./fitScore";
import { openInPanel } from "./FileView";
import { useSettings } from "./settings";
import { terminalScrollbarCSS } from "./TerminalView";

const MAX_SHOWN = 100;
/** What being opened before is worth: about a few letters' fit, and the latest first among equals. */
const RECENT_SCORE = 6;
const SCOPE_KEY = "QuickOpen:scope";

type Scope = "folder" | "all";

function savedScope(): Scope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "folder";
  } catch {
    return "folder";
  }
}

/**
 * ⌘P: finds a file in the tab's repo, or all your code (Settings), by a few
 * letters of its path, and opens it in the panel. Files you've opened before
 * come first, and count even if ignored, which is how to get to those.
 */
export function QuickOpen({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const [list, setList] = useState<{ root: string; paths: string[]; recent?: string[]; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { searchFolders } = useSettings();
  const canScope = daemon.speaks(21);
  const [savedChoice, setScopeChoice] = useState(savedScope);
  const scope = canScope ? savedChoice : "folder";

  function setScope(next: Scope) {
    setScopeChoice(next);
    setActive(0);
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {}
  }

  useEffect(() => {
    let current = true;
    setList(null);
    const roots = scope === "all" ? searchFolders.split(",").map((root) => root.trim()).filter(Boolean) : undefined;
    void daemon.listFiles(tab.cwd ?? daemon.getSnapshot().state?.home ?? "/", roots).then(
      (result) => current && setList(result),
      () => current && setList({ root: "", paths: [], truncated: false }),
    );
    return () => {
      current = false;
    };
  }, [scope]);

  const recent = list?.recent ?? [];
  const matches = [...new Set([...recent, ...(list?.paths ?? [])])]
    .flatMap((path, index) => {
      const fit = fitScore(query, path);
      if (!fit) return [];
      return [{ ...fit, path, score: fit.score + (index < recent.length ? RECENT_SCORE - index / recent.length : 0) }];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SHOWN);

  function open(path: string) {
    if (!list) return;
    openInPanel(tab, `${list.root}/${path}`);
    onClose();
  }

  function onKeyDown(event: KeyboardEvent) {
    if (canScope && event.code === "KeyV" && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      return setScope(scope === "all" ? "folder" : "all");
    }
    const move = (next: number) => {
      const index = Math.max(0, Math.min(matches.length - 1, next));
      setActive(index);
      listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
    };
    if (event.key === "ArrowDown") move(active + 1);
    else if (event.key === "ArrowUp") move(active - 1);
    else if (event.key === "Enter" && matches[active]) open(matches[active].path);
    else if (event.key === "Escape") onClose();
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <StyledQuickOpen onClick={onClose}>
      <div className="box" onClick={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="field">
          <input
            autoFocus
            value={query}
            placeholder="Go to file"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
          {canScope && (
            // Pressing one leaves the keyboard in the field.
            <div className="mode" onMouseDown={(event) => event.preventDefault()}>
              <button data-on={scope === "folder"} onClick={() => setScope("folder")} {...tooltip("This repo", { hotkey: "cmd+shift+v", delay: true })}>
                This repo
              </button>
              <button data-on={scope === "all"} onClick={() => setScope("all")} {...tooltip(searchFolders, { hotkey: "cmd+shift+v", delay: true })}>
                All code
              </button>
            </div>
          )}
        </div>
        <div className="list" ref={listRef}>
          {matches.map(({ path, hits }, index) => (
            <div key={path} className="row" data-active={index === active} onClick={() => open(path)} onMouseMove={() => setActive(index)}>
              <FileIcon name={path.split("/").pop()!} />
              <Marked path={path} hits={hits} />
            </div>
          ))}
          {list && matches.length === 0 && <div className="note">No files.</div>}
        </div>
      </div>
    </StyledQuickOpen>
  );
}

function Marked({ path, hits }: { path: string; hits: number[] }) {
  const nameStart = path.lastIndexOf("/") + 1;
  const marked = new Set(hits);
  const letters = (from: number, to: number) =>
    [...path.slice(from, to)].map((char, index) => (marked.has(from + index) ? <b key={index}>{char}</b> : char));
  return (
    <>
      <span className="base">{letters(nameStart, path.length)}</span>
      <span className="folder">{letters(0, nameStart)}</span>
    </>
  );
}

const StyledQuickOpen = styled.div`
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 72px 16px 16px;

  > .box {
    width: 560px;
    max-width: 100%;
    max-height: min(420px, 100%);
    display: flex;
    flex-flow: column;
    overflow: hidden;
    border: 1px solid ${colors.separator()};
    border-radius: 10px;
    background: ${colors.textBackgroundPanel()};
    color: ${colors.text()};
    box-shadow: 0 8px 32px rgb(0 0 0 / 0.3);

    > .field {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 8px;
      padding-right: 10px;
      border-bottom: 1px solid ${colors.separator()};

      > input {
        flex: 1;
        min-width: 0;
        padding: 10px 14px;
        border: none;
        outline: none;
        background: none;
        color: inherit;
        font: ${fonts.display({ size: 15, line: "22px" })};
      }

      /* Like a file's Preview | Source. */
      > .mode {
        flex-shrink: 0;
        display: flex;
        padding: 2px;
        border-radius: 8px;
        background: ${colors.buttonBackgroundGlow()};

        > button {
          height: 22px;
          padding: 0 10px;
          border: none;
          border-radius: 6px;
          background: transparent;
          color: ${colors.textSecondary()};
          font: ${fonts.displayMedium({ size: 12, line: "16px" })};
          cursor: pointer;

          &[data-on="true"] {
            background: ${colors.textBackground()};
            color: ${colors.text()};
            box-shadow: 0 1px 2px rgb(0 0 0 / 0.15);
          }
        }
      }
    }

    > .list {
      min-height: 0;
      overflow: auto;
      padding: 4px 0;
      ${terminalScrollbarCSS}

      > .note {
        padding: 8px 14px;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 13, line: "20px" })};
      }

      > .row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 3px 14px;
        font: ${fonts.display({ size: 13, line: "20px" })};
        white-space: nowrap;
        cursor: default;

        &[data-active="true"] {
          background: ${colors.buttonBackgroundGlow()};
        }

        > .base {
          flex-shrink: 0;
          max-width: 70%;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        > .folder {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          color: ${colors.textSecondary()};
          font-size: 12px;
        }

        b {
          font-weight: 700;
          color: ${colors.turquoise()};
        }
      }
    }
  }
`;
