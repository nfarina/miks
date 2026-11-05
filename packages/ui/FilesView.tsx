import { colors } from "crosswing/colors";
import { safeArea } from "crosswing/safearea";
import { fonts } from "crosswing/fonts";
import { PopupMenu, PopupMenuSeparator, PopupMenuText } from "crosswing/components/PopupMenu";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { tooltip } from "crosswing/modals/popup";
import { usePopup } from "crosswing/modals/popup/usePopup";
import { ArrowUp, ChevronRight, Copy, FileText, FolderOpen, FolderSearch, RotateCw } from "lucide-react";
import type { FolderEntry, Tab } from "miks/shared/protocol";
import { displayPath } from "miks/shared/settings";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { FileIcon } from "./fileIcons";
import { filterTree, type TreeFile, type TreeRow } from "./filterTree";
import { openInPanel, whyNoFinder } from "./FileView";
import { useSettings } from "./settings";
import { terminalScrollbarCSS } from "./TerminalView";

const join = (folder: string, name: string) => (folder === "/" ? `/${name}` : `${folder}/${name}`);
const parent = (folder: string) => folder.replace(/\/[^/]*$/, "") || "/";
const isInside = (path: string, folder: string) => path.startsWith(folder === "/" ? "/" : `${folder}/`);

/** A folder's listing, or why there's none. */
type Listing = { entries?: FolderEntry[]; error?: string };

/**
 * The panel's file browser, on the tab's Mac: starting from where the tab's
 * shell is, and staying where you've gone after that, until `center` changes
 * (⌘⇧E). Folders load as they open, and again each time it comes on show.
 * A double click or ⌘↓ opens a file, as in Finder, and a click only selects
 * it, except on a touch screen, where a tap passes through it. A right click
 * has the rest. ⌘↑ goes up a folder. Typing filters everything under the root,
 * opened or not (`filterTree`), until Escape. `reveal` (⌘⇧\)
 * opens the folders down to a file, from the root if it's in there, else from
 * where the shell is, else from its own folder.
 */
export function FilesView({
  tab,
  showing,
  center,
  reveal,
  onHide,
}: {
  tab: Tab;
  showing: boolean;
  center: number;
  reveal: { path: string; count: number } | null;
  onHide: () => void;
}) {
  const { hidePathPrefix } = useSettings();
  const home = daemon.getSnapshot().state?.home ?? null;
  const [root, setRoot] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // The repo's files, as of when the filter started: nothing else knows of unopened folders.
  const [repoFiles, setRepoFiles] = useState<TreeFile[]>([]);
  const filtering = !!filter.trim();
  const rootRef = useRef<HTMLDivElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const touch = useMatchMedia("(pointer: coarse)");
  // What the menu's for: its popup can be shown only from the click itself.
  const menuRow = useRef<{ path: string; folder: boolean } | null>(null);

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
    setFilter("");
  }, [center, !!tab.cwd]);

  // After the effect above, as it opens for this.
  const scrollTo = useRef<string | null>(null);
  function showInTree(path: string, folders: string[] = []) {
    const cwd = tab.cwd ?? home;
    const top = root && isInside(path, root) ? root : cwd && isInside(path, cwd) ? cwd : parent(path);
    for (let folder = parent(path); folder !== top; folder = parent(folder)) folders.push(folder);
    setFilter("");
    setRoot(top);
    setOpen((current) => new Set([...current, ...folders]));
    for (const folder of folders) load(folder);
    setSelected(path);
    scrollTo.current = path;
  }

  useEffect(() => {
    if (reveal) showInTree(reveal.path);
  }, [reveal?.count]);

  useEffect(() => {
    if (!filtering || !root) return;
    let current = true;
    void daemon.listFiles(root).then(
      (list) => current && setRepoFiles([...list.recent ?? [], ...list.paths].map((path) => ({ path: join(list.root, path), folder: false }))),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [filtering, root]);

  // Once its folders have loaded and it has a row.
  useEffect(() => {
    if (!scrollTo.current) return;
    const row = rootRef.current?.querySelector(`[data-row="${CSS.escape(scrollTo.current)}"]`);
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    scrollTo.current = null;
  });

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
  const rows: TreeRow[] = [];
  const addRows = (folder: string, depth: number) => {
    for (const entry of listings[folder]?.entries ?? []) {
      const path = join(folder, entry.name);
      rows.push({ path, name: entry.name, entry, depth, expanded: open.has(path), hits: [], score: 0 });
      if (entry.folder && open.has(path)) addRows(path, depth + 1);
    }
  };
  if (root && filtering) {
    // What's been read counts too: it's how ignored files get in.
    const loaded = Object.entries(listings).flatMap(([folder, { entries = [] }]) =>
      entries.map((entry) => ({ ...entry, path: join(folder, entry.name) })),
    );
    rows.push(...filterTree(root, [...repoFiles, ...loaded], filter));
  } else if (root) addRows(root, 0);

  // The best fit, for Enter, as the list narrows.
  useEffect(() => {
    if (!filtering) return;
    const best = rows.reduce<TreeRow | null>((most, row) => (row.score > (most?.score ?? -Infinity) ? row : most), null);
    if (!best) return;
    setSelected(best.path);
    scrollTo.current = best.path;
  }, [filter, repoFiles]);

  const stopFiltering = () => {
    setFilter("");
    treeRef.current?.focus({ preventScroll: true });
  };

  const openFolder = (path: string) => (filtering ? showInTree(path, [path]) : toggle(path));

  const goUp = () => root && root !== "/" && setRoot(parent(root));

  const menu = usePopup(
    () => {
      const row = menuRow.current;
      if (!row) return null;
      const finderMissing = whyNoFinder();
      return (
        <PopupMenu>
          {row.folder ? (
            <PopupMenuText icon={<FolderOpen />} onClick={() => setRoot(row.path)} children="Open" />
          ) : (
            <PopupMenuText icon={<FileText />} onClick={() => openInPanel(tab, row.path, { keep: true })} children="Open" />
          )}
          <PopupMenuSeparator />
          <PopupMenuText
            icon={<FolderSearch />}
            disabled={!!finderMissing}
            detail={finderMissing}
            onClick={() => daemon.send({ type: "showFolder", path: row.path, reveal: true })}
            children="Reveal in Finder"
          />
          <PopupMenuText icon={<Copy />} onClick={() => window.miks?.copy(row.path)} children="Copy path" />
        </PopupMenu>
      );
    },
    { anchor: "cursor" },
  );

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") return filter ? stopFiltering() : onHide();
    const typed = event.key.length === 1 && !event.metaKey && !event.ctrlKey && (filter || event.key !== " ");
    if (typed || (event.key === "Backspace" && filter)) {
      event.preventDefault();
      setFilter(typed ? filter + event.key : filter.slice(0, -1));
      filterRef.current?.focus();
      return;
    }
    if (event.metaKey && event.key === "ArrowUp") {
      event.preventDefault();
      return void goUp();
    }
    const index = rows.findIndex((row) => row.path === selected);
    const row = rows[index];
    const move = (next: number) => {
      const target = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (!target) return;
      setSelected(target.path);
      rootRef.current?.querySelector(`[data-row="${CSS.escape(target.path)}"]`)?.scrollIntoView({ block: "nearest" });
    };
    if (event.metaKey && event.key === "ArrowDown") {
      if (row?.entry.folder) (filtering || !open.has(row.path)) && openFolder(row.path);
      else if (row) openInPanel(tab, row.path, { keep: true });
    } else if (filtering && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
    else if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "ArrowRight" && row?.entry.folder && !open.has(row.path)) toggle(row.path);
    else if (event.key === "ArrowLeft" && row?.entry.folder && open.has(row.path)) toggle(row.path);
    else if (event.key === "ArrowLeft" && row) move(rows.findIndex((other) => other.path === parent(row.path)));
    else if (event.key === "Enter" && row) row.entry.folder ? openFolder(row.path) : openInPanel(tab, row.path, { keep: true });
    else return;
    event.preventDefault();
  }

  // The field has the keyboard while filtering, but the list has the keys that move in it.
  function onFilterKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      stopFiltering();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter") onKeyDown(event);
  }

  const error = root ? listings[root]?.error : null;

  return (
    <StyledFilesView ref={rootRef}>
      <div className="header">
        <button disabled={!root || root === "/"} onClick={goUp} {...tooltip("Up a folder", { delay: true, placement: "below" })}>
          <ArrowUp />
        </button>
        <span className="where" {...tooltip(root, { delay: true, placement: "below" })}>
          <bdi>{root ? displayPath(root, hidePathPrefix, home) : ""}</bdi>
        </span>
        <button onClick={refresh} {...tooltip("Refresh", { delay: true, placement: "below" })}>
          <RotateCw />
        </button>
      </div>
      {/* Always there, to take the keyboard during the keystroke that starts it. */}
      <div className="filter" data-on={!!filter}>
        <input
          ref={filterRef}
          value={filter}
          tabIndex={-1}
          placeholder="Filter"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => (event.target.value ? setFilter(event.target.value) : stopFiltering())}
          onKeyDown={onFilterKeyDown}
        />
      </div>
      {error && <div className="note">{error}</div>}
      {filtering && rows.length === 0 && <div className="note">No files.</div>}
      <div ref={treeRef} className="tree" tabIndex={0} data-panel-focus onKeyDown={onKeyDown}>
        {rows.map(({ path, name, entry, depth, expanded, hits }) => (
          <div
            key={path}
            className="row"
            data-row={path}
            data-selected={selected === path}
            data-ignored={entry.ignored}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => {
              setSelected(path);
              if (entry.folder) openFolder(path);
              else if (touch) openInPanel(tab, path);
            }}
            onDoubleClick={() => !entry.folder && openInPanel(tab, path, { keep: true })}
            onContextMenu={(event) => {
              event.preventDefault();
              setSelected(path);
              menuRow.current = { path, folder: entry.folder };
              menu.onClick(event);
            }}
          >
            {entry.folder ? <ChevronRight className="chevron" data-open={expanded} /> : <span className="chevron" />}
            <FileIcon name={name} folder={entry.folder} open={expanded} />
            <span className="name">{[...name].map((char, index) => (hits.includes(index) ? <b key={index}>{char}</b> : char))}</span>
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
    padding-right: ${safeArea.right("8px")};
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

  > .filter {
    flex-shrink: 0;
    border-bottom: 1px solid ${colors.separator()};

    /* Not display: none, which couldn't take the keyboard. */
    &[data-on="false"]:not(:focus-within) {
      height: 0;
      overflow: hidden;
      border: none;
    }

    > input {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 6px 12px;
      padding-right: ${safeArea.right("12px")};
      border: none;
      outline: none;
      background: none;
      color: inherit;
      font: ${fonts.display({ size: 13, line: "20px" })};
    }
  }

  > .note {
    padding: 16px;
    padding-right: ${safeArea.right("16px")};
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
    padding-right: ${safeArea.right("10px")};
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

      > b {
        font-weight: 700;
        color: ${colors.turquoise()};
      }
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
