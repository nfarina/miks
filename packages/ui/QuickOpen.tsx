import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import type { Tab } from "miks/shared/protocol";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { FileIcon } from "./fileIcons";
import { openInPanel } from "./FileView";
import { terminalScrollbarCSS } from "./TerminalView";

const MAX_SHOWN = 100;

/**
 * How well `query` fits `path`, its letters in order, or null if they
 * aren't all there. Higher for runs of letters, for starts of words, and for
 * landing in the file's name; a little lower for a longer path.
 */
export function fitScore(query: string, path: string): { score: number; hits: number[] } | null {
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const hits: number[] = [];
  let score = -path.length / 100;
  let at = 0;
  for (const char of query.toLowerCase()) {
    if (char === " ") continue;
    // The last place it fits from the end for the first letter would be
    // better still, but in order from the left is close and much cheaper.
    const found = lower.indexOf(char, at);
    if (found === -1) return null;
    const before = path[found - 1];
    if (hits.at(-1) === found - 1) score += 4;
    if (found === 0 || "/._-".includes(before ?? "") || (/[A-Z]/.test(path[found]) && /[a-z]/.test(before ?? ""))) score += 3;
    if (found >= nameStart) score += 2;
    hits.push(found);
    at = found + 1;
  }
  return { score, hits };
}

/** ⌘P: finds a file in the tab's repo by a few letters of its path, and opens it in the panel. */
export function QuickOpen({ tab, onClose }: { tab: Tab; onClose: () => void }) {
  const [list, setList] = useState<{ root: string; paths: string[]; truncated: boolean } | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void daemon.listFiles(tab.cwd ?? daemon.getSnapshot().state?.home ?? "/").then(
      (result) => current && setList(result),
      () => current && setList({ root: "", paths: [], truncated: false }),
    );
    return () => {
      current = false;
    };
  }, []);

  const matches = (list?.paths ?? [])
    .flatMap((path) => {
      const fit = fitScore(query, path);
      return fit ? [{ path, ...fit }] : [];
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SHOWN);

  function open(path: string) {
    if (!list) return;
    openInPanel(tab, `${list.root}/${path}`);
    onClose();
  }

  function onKeyDown(event: KeyboardEvent) {
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

    > input {
      flex-shrink: 0;
      padding: 10px 14px;
      border: none;
      border-bottom: 1px solid ${colors.separator()};
      outline: none;
      background: none;
      color: inherit;
      font: ${fonts.display({ size: 15, line: "22px" })};
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
