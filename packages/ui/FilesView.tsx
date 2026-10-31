import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { tooltip } from "crosswing/modals/popup";
import { ArrowUp, ChevronRight, RotateCw } from "lucide-react";
import type { FolderEntry, Tab } from "miks/shared/protocol";
import { displayPath } from "miks/shared/settings";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { FileIcon } from "./fileIcons";
import { openInPanel } from "./FileView";
import { useSettings } from "./settings";
import { terminalScrollbarCSS } from "./TerminalView";

const join = (folder: string, name: string) => (folder === "/" ? `/${name}` : `${folder}/${name}`);
const parent = (folder: string) => folder.replace(/\/[^/]*$/, "") || "/";

/** A folder's listing, or why there's none. */
type Listing = { entries?: FolderEntry[]; error?: string };

/**
 * The panel's file browser, on the tab's Mac: starting from where the tab's
 * shell is, and staying where you've gone after that, until `center` changes
 * (⌘⇧E). Folders load as they open, and again each time it comes on show.
 * A click passes through a file; a double click keeps it.
 */
export function FilesView({ tab, showing, center, onHide }: { tab: Tab; showing: boolean; center: number; onHide: () => void }) {
  const { hidePathPrefix } = useSettings();
  const home = daemon.getSnapshot().state?.home ?? null;
  const [root, setRoot] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const load = (folder: string) =>
    void daemon.readFolder(folder).then(
      (listing) => setListings((current) => ({ ...current, [folder]: listing })),
      (error) => setListings((current) => ({ ...current, [folder]: { error: error.message } })),
    );

  useEffect(() => {
    if (!tab.cwd && !home) return;
    const folder = tab.cwd ?? home!;
    setRoot(folder);
    setSelected(null);
  }, [center, !!tab.cwd]);

  // What's on show, read again: nothing watches a whole tree.
  const refresh = () => {
    if (!root) return;
    for (const folder of [root, ...open]) load(folder);
  };
  useEffect(() => {
    if (showing) refresh();
  }, [showing, root]);

  function toggle(folder: string) {
    const next = new Set(open);
    if (next.delete(folder)) return setOpen(next);
    next.add(folder);
    setOpen(next);
    load(folder);
  }

  // The rows as they stand, for the arrow keys.
  const rows: { path: string; name: string; entry: FolderEntry; depth: number }[] = [];
  const addRows = (folder: string, depth: number) => {
    for (const entry of listings[folder]?.entries ?? []) {
      const path = join(folder, entry.name);
      rows.push({ path, name: entry.name, entry, depth });
      if (entry.folder && open.has(path)) addRows(path, depth + 1);
    }
  };
  if (root) addRows(root, 0);

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") return onHide();
    const index = rows.findIndex((row) => row.path === selected);
    const row = rows[index];
    const move = (next: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!target) return;
      setSelected(target.path);
      rootRef.current?.querySelector(`[data-row="${CSS.escape(target.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "ArrowRight" && row?.entry.folder && !open.has(row.path)) toggle(row.path);
    else if (event.key === "ArrowLeft" && row?.entry.folder && open.has(row.path)) toggle(row.path);
    else if (event.key === "ArrowLeft" && row) move(rows.findIndex((other) => other.path === parent(row.path)));
    else if (event.key === "Enter" && row) row.entry.folder ? toggle(row.path) : openInPanel(tab, row.path, { keep: true });
    else return;
    event.preventDefault();
  }

  const error = root ? listings[root]?.error : null;

  return (
    <StyledFilesView ref={rootRef}>
      <div className="header">
        <button disabled={!root || root === "/"} onClick={() => root && setRoot(parent(root))} {...tooltip("Up a folder", { delay: true, placement: "below" })}>
          <ArrowUp />
        </button>
        <span className="where" {...tooltip(root, { delay: true, placement: "below" })}>
          <bdi>{root ? displayPath(root, hidePathPrefix, home) : ""}</bdi>
        </span>
        <button onClick={refresh} {...tooltip("Refresh", { delay: true, placement: "below" })}>
          <RotateCw />
        </button>
      </div>
      {error && <div className="note">{error}</div>}
      <div className="tree" tabIndex={0} data-panel-focus onKeyDown={onKeyDown}>
        {rows.map(({ path, name, entry, depth }) => (
          <div
            key={path}
            className="row"
            data-row={path}
            data-selected={selected === path}
            data-ignored={entry.ignored}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              setSelected(path);
              if (entry.folder) toggle(path);
              else openInPanel(tab, path);
            }}
            onDoubleClick={() => !entry.folder && openInPanel(tab, path, { keep: true })}
          >
            {entry.folder ? <ChevronRight className="chevron" data-open={open.has(path)} /> : <span className="chevron" />}
            <FileIcon name={name} folder={entry.folder} open={open.has(path)} />
            <span className="name">{name}</span>
          </div>
        ))}
      </div>
    </StyledFilesView>
  );
}

const StyledFilesView = styled.div`
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-flow: column;

  > .header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid ${colors.separator()};

    > .where {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      /* The end of a path is the part that tells them apart. */
      direction: rtl;
      text-align: left;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "20px" })};
    }

    > button {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 6px;
      background: none;
      color: ${colors.textSecondary()};
      cursor: pointer;

      &:disabled {
        opacity: 0.4;
        cursor: default;
      }

      &:hover:enabled {
        background: ${colors.buttonBackgroundGlow()};
      }

      > svg {
        width: 15px;
        height: 15px;
      }
    }
  }

  > .note {
    padding: 16px;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13, line: "20px" })};
  }

  > .tree {
    flex-grow: 1;
    min-height: 0;
    overflow: auto;
    padding: 4px 0 12px;
    outline: none;
    ${terminalScrollbarCSS}
  }

  > .tree > .row {
    display: flex;
    align-items: center;
    gap: 5px;
    height: 26px;
    padding-right: 10px;
    font: ${fonts.display({ size: 13, line: "26px" })};
    white-space: nowrap;
    cursor: default;
    -webkit-user-select: none;
    user-select: none;

    @media (pointer: coarse) {
      height: 36px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }

    &[data-selected="true"] {
      background: ${colors.buttonBackgroundGlow()};
    }

    &[data-ignored="true"] {
      opacity: 0.5;
    }

    > .name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    > svg {
      flex-shrink: 0;
      width: 15px;
      height: 15px;
      color: ${colors.textSecondary()};
    }

    > .chevron {
      flex-shrink: 0;
      width: 13px;
      height: 13px;
      transition: transform 0.1s;

      &[data-open="true"] {
        transform: rotate(90deg);
      }
    }
  }
`;
