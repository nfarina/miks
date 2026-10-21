import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { tooltip } from "crosswing/modals/popup";
import { PanelLeft, Plus } from "lucide-react";
import { Workspace } from "miks/shared/protocol";
import { Fragment, HTMLAttributes, KeyboardEvent, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { useDraggable } from "crosswing/components/draggable/useDraggable";
import { displayPath, updateSettings, useSettings } from "./settings";
import { backgroundSummary, STATUS_LABELS, waitingMessage, workspaceStatus, workspaceTitle } from "./status";
import { StatusDot } from "./StatusDot";

const DRAG_GROUP = "workspaces";

export function Sidebar({
  workspaces,
  activeWorkspaceId,
  home,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  home: string;
}) {
  // Press and hold a workspace to drag it somewhere else in the list.
  useDraggable({
    group: DRAG_GROUP,
    lockAxis: "y",
    onDrop: (workspaceId, target) =>
      daemon.send({ type: "moveWorkspace", workspaceId, index: dropIndex(workspaces, workspaceId, target) }),
  });

  return (
    <StyledSidebar {...rest}>
      <div className="titlebar">
        <SidebarToggle />
      </div>
      <div className="workspaces" data-draggable-root>
        <WorkspaceDropTarget data-draggable-target="top" data-draggable-group={DRAG_GROUP} />
        {workspaces.map((workspace, index) => (
          <Fragment key={workspace.id}>
            <WorkspaceRow
              workspace={workspace}
              home={home}
              shortcut={index < 9 ? `⌘${index + 1}` : undefined}
              selected={workspace.id === activeWorkspaceId}
            />
            <WorkspaceDropTarget
              data-draggable-target={`after:${workspace.id}`}
              data-draggable-group={DRAG_GROUP}
              data-draggable-related-id={workspace.id}
            />
          </Fragment>
        ))}
      </div>
      <button className="new-workspace" onClick={() => daemon.send({ type: "createWorkspace" })}>
        <Plus />
        <span>New workspace</span>
      </button>
    </StyledSidebar>
  );
}

export const StyledSidebar = styled.div`
  display: flex;
  flex-flow: column;
  background: ${colors.textBackgroundPanel()};
  height: 100%;
  user-select: none;

  > .titlebar {
    /* Room for the traffic lights, and something to drag the window by. */
    flex-shrink: 0;
    height: 44px;
    -webkit-app-region: drag;
    display: flex;
    justify-content: flex-end;
    /* In line with the tab bar's buttons beside it. */
    padding: 6px 6px 0 0;
    box-sizing: border-box;
  }

  > .workspaces {
    flex-grow: 1;
    overflow-y: auto;
    display: flex;
    flex-flow: column;
    padding: 0 8px;
  }

  > .new-workspace {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px;
    padding: 8px 10px;
    border: none;
    /* Concentric with the window's corner, 8px in from it. */
    border-radius: 16px;
    background: transparent;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13 })};
    cursor: pointer;

    > svg {
      width: 16px;
      height: 16px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
      color: ${colors.text()};
    }
  }
`;

/**
 * Shows or hides the sidebar (⌘B): in the sidebar while it shows, and at the
 * start of the tab bar while it doesn't.
 */
export function SidebarToggle() {
  const { sidebarVisible } = useSettings();
  return (
    <StyledSidebarToggle
      data-on={sidebarVisible}
      onClick={() => updateSettings({ sidebarVisible: !sidebarVisible })}
      {...tooltip(sidebarVisible ? "Hide sidebar" : "Show sidebar", { hotkey: "cmd+b", delay: true })}
    >
      <PanelLeft />
    </StyledSidebarToggle>
  );
}

export const StyledSidebarToggle = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: ${colors.textSecondary()};
  -webkit-app-region: no-drag;

  > svg {
    width: 15px;
    height: 15px;
  }

  &:hover {
    background: ${colors.buttonBackgroundGlow()};
    color: ${colors.text()};
  }
`;

/**
 * Where a drop lands, as an index in the list without the dragged item:
 * targets are "top" or `after:<id>`, and sit between the rows.
 */
export function dropIndex(items: { id: string }[], movingId: string, target: string): number {
  const [kind, afterId] = target.split(":");
  if (kind !== "after") return 0;
  return items.filter((item) => item.id !== movingId).findIndex((item) => item.id === afterId) + 1;
}

/** The gap a dragged row opens up where it would land. */
export const WorkspaceDropTarget = styled.div`
  flex-shrink: 0;
  height: var(--target-height, 0px);
  border-radius: 16px;

  &[data-draggable-hover="true"] {
    background: ${colors.buttonBackgroundGlow()};
  }
`;

function WorkspaceRow({
  workspace,
  home,
  shortcut,
  selected,
}: {
  workspace: Workspace;
  home: string;
  shortcut?: string;
  selected: boolean;
}) {
  const { hidePathPrefix } = useSettings();
  const [renaming, setRenaming] = useState(false);
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  const cwd = activeTab?.cwd ?? workspace.cwd;
  const status = workspaceStatus(workspace);
  const message = status === "waiting" ? waitingMessage(workspace) : null;
  const background = backgroundSummary(workspace);
  const title = workspaceTitle(workspace);

  function onRenameKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      daemon.send({ type: "renameWorkspace", workspaceId: workspace.id, title: event.currentTarget.value });
      setRenaming(false);
    } else if (event.key === "Escape") {
      setRenaming(false);
    }
  }

  return (
    <StyledWorkspaceRow
      data-draggable-id={workspace.id}
      data-draggable-group={DRAG_GROUP}
      data-selected={selected}
      data-status={status ?? undefined}
      onClick={() => daemon.send({ type: "select", workspaceId: workspace.id })}
      onDoubleClick={() => setRenaming(true)}
      title="Double-click to rename"
    >
      <div className="box">
        <div className="top">
          {renaming ? (
            <input
              autoFocus
              defaultValue={workspace.title ?? ""}
              placeholder={title}
              onKeyDown={onRenameKeyDown}
              onBlur={() => setRenaming(false)}
              onClick={(event) => event.stopPropagation()}
            />
          ) : (
            <div className="title">{title}</div>
          )}
          {shortcut && !renaming && <div className="shortcut">{shortcut}</div>}
        </div>
        <div className="cwd" title={cwd}>
          {displayPath(cwd, hidePathPrefix, home)}
        </div>
        <div className="bottom">
          {status && <StatusDot status={status} />}
          <div className="detail">
            {message ?? (status ? STATUS_LABELS[status] : plural(workspace.tabs.length, "tab"))}
          </div>
          {background && <div className="background">· {background}</div>}
        </div>
      </div>
    </StyledWorkspaceRow>
  );
}

// The row and its spacing are one box, with the visuals on .box inside it:
// the dragging copy is sized from the row's border box, so padding outside
// it (or a margin) would make the copy grow and the list shift.
const StyledWorkspaceRow = styled.div`
  box-sizing: border-box;
  padding: 1px 0;
  cursor: default;
  user-select: none;

  > .box {
    display: flex;
    flex-flow: column;
    gap: 3px;
    padding: 8px 10px;
    /* As the New workspace button's, which matches the window's corner. */
    border-radius: 16px;

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }

    > .top {
      display: flex;
      align-items: center;
      gap: 8px;

      > .title {
        flex-grow: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: ${colors.text()};
        font: ${fonts.displayMedium({ size: 13 })};
      }

      > input {
        flex-grow: 1;
        min-width: 0;
        padding: 0 4px;
        margin: -1px -5px;
        border: 1px solid ${colors.primary()};
        border-radius: 4px;
        outline: none;
        background: ${colors.textBackground()};
        color: ${colors.text()};
        font: ${fonts.displayMedium({ size: 13 })};
      }

      > .shortcut {
        flex-shrink: 0;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 11 })};
        opacity: 0.7;
      }
    }

    > .cwd {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12 })};
    }

    > .bottom {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 16px;

      > .detail {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 12 })};
      }

      /* Kept whole: a long message gives way first. */
      > .background {
        flex-shrink: 0;
        white-space: nowrap;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 12 })};
      }
    }
  }

  &[data-selected="true"] > .box {
    background: ${colors.linkActiveBackground()};
  }

  &[data-status="waiting"] > .box > .bottom > .detail {
    color: ${colors.orange()};
  }

  /* The copy that follows the pointer while dragging. */
  &[data-dragging="true"] > .box {
    background: ${colors.textBackgroundPanel()};
    box-shadow: 0 6px 20px rgb(0 0 0 / 0.25);
  }
`;

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
