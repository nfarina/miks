import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { Maximize2, Minimize2, PanelRight, Plus, RotateCw, X } from "lucide-react";
import type { Tab, Workspace } from "miks/shared/protocol";
import { Fragment, HTMLAttributes } from "react";
import { styled } from "styled-components";
import { coarsePointer } from "crosswing/host/pointer";
import { safeArea } from "crosswing/safearea";
import { hasPanel, toggleChat, toggleExpanded, useChatOpen, useExpanded } from "./ChatPanel";
import { closeTab } from "./closing";
import { daemon } from "./daemon";
import { useDraggable } from "crosswing/components/draggable/useDraggable";
import { tooltip } from "crosswing/modals/popup";
import { useSettings } from "./settings";
import { dropIndex, SidebarToggle, StyledSidebarToggle } from "./Sidebar";
import { tabTitle } from "./status";
import { StatusDot } from "./StatusDot";

const DRAG_GROUP = "tabs";

export function TabBar({ workspace, ...rest }: HTMLAttributes<HTMLDivElement> & { workspace: Workspace }) {
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  const chatOpen = useChatOpen(activeTab ?? null);
  const expanded = useExpanded(activeTab ?? null);
  const { sidebarVisible } = useSettings();

  // Press and hold a tab to drag it along the bar.
  useDraggable({
    group: DRAG_GROUP,
    lockAxis: "x",
    onDrop: (tabId, target) => daemon.send({ type: "moveTab", tabId, index: dropIndex(workspace.tabs, tabId, target) }),
  });

  return (
    <StyledTabBar data-draggable-root {...rest}>
      {/* While the sidebar shows, it has this itself. */}
      {!sidebarVisible && <SidebarToggle />}
      <TabDropTarget data-draggable-target="top" data-draggable-group={DRAG_GROUP} />
      {workspace.tabs.map((tab) => (
        <Fragment key={tab.id}>
          <TabView tab={tab} workspaceId={workspace.id} active={tab.id === workspace.activeTabId} />
          <TabDropTarget
            data-draggable-target={`after:${tab.id}`}
            data-draggable-group={DRAG_GROUP}
            data-draggable-related-id={tab.id}
          />
        </Fragment>
      ))}
      <button
        className="new-tab"
        {...tooltip("New tab", { hotkey: "cmd+t", delay: true })}
        onClick={() => daemon.send({ type: "createTab", workspaceId: workspace.id })}
      >
        <Plus />
      </button>
      <div className="spacer" />
      {/* The tab's panel filling the tab, or beside the terminal. */}
      {activeTab && hasPanel(activeTab) && chatOpen && (
        <button
          className="expand-toggle"
          data-on={expanded}
          onClick={() => toggleExpanded(activeTab)}
          {...tooltip(expanded ? "Put the panel beside the terminal" : "Fill the tab with the panel", {
            hotkey: "cmd+shift+f",
            delay: true,
          })}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </button>
      )}
      {/* The tab's panel: its conversation, while Claude Code runs in it, a file or a page. */}
      {activeTab && hasPanel(activeTab) && (
        <button
          className="chat-toggle"
          data-on={chatOpen}
          onClick={() => toggleChat(activeTab)}
          {...tooltip(chatOpen ? "Hide panel" : "Show panel", { hotkey: "cmd+shift+c", delay: true })}
        >
          <PanelRight />
        </button>
      )}
    </StyledTabBar>
  );
}

export const StyledTabBar = styled.div`
  display: flex;
  align-items: center;
  height: 38px;
  flex-shrink: 0;
  /* Under the status bar, with the screen's edges kept clear. */
  padding: ${safeArea.top()} ${safeArea.right("6px")} 0 ${safeArea.left("6px")};
  border-bottom: 1px solid ${colors.separator()};
  user-select: none;
  -webkit-app-region: drag;

  > button {
    -webkit-app-region: no-drag;
  }

  > .new-tab,
  > .expand-toggle,
  > .chat-toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 26px;
    margin-left: 2px;
    border: none;
    border-radius: 7px;
    background: transparent;
    color: ${colors.textSecondary()};

    > svg {
      width: 15px;
      height: 15px;
    }

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
      color: ${colors.text()};
    }
  }

  > .expand-toggle > svg {
    width: 14px;
    height: 14px;
  }

  > .chat-toggle {
    margin: 0 2px 0 2px;
  }

  > ${StyledSidebarToggle} {
    margin: 0 4px 0 0;
  }

  > .chat-toggle[data-on="true"] {
    color: ${colors.text()};
  }

  > .spacer {
    flex-grow: 1;
  }

  /* Finger-sized, on a touch screen. */
  ${coarsePointer(`
    height: 48px;

    > .new-tab,
    > .expand-toggle,
    > .chat-toggle {
      width: 40px;
      height: 38px;
      border-radius: 10px;

      > svg {
        width: 19px;
        height: 19px;
      }
    }

    > .expand-toggle > svg {
      width: 18px;
      height: 18px;
    }
  `)}
`;

function TabView({ tab, workspaceId, active }: { tab: Tab; workspaceId: string; active: boolean }) {
  return (
    <StyledTab
      data-draggable-id={tab.id}
      data-draggable-group={DRAG_GROUP}
      data-active={active}
      onClick={() => daemon.send({ type: "select", workspaceId, tabId: tab.id })}
      onAuxClick={(event) => event.button === 1 && closeTab(tab)}
    >
      <div className="box">
        {tab.agent && <StatusDot status={tab.agent.status} />}
        <div className="title">{tabTitle(tab)}</div>
        {tab.kept && (
          <span className="kept" title="Runs again when Miks restores this tab">
            <RotateCw />
          </span>
        )}
        <button
          className="close"
          title="Close tab (⌘W)"
          // Not a drag: closing should work on a quick click.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            closeTab(tab);
          }}
        >
          <X />
        </button>
      </div>
    </StyledTab>
  );
}

// Styled on its own, not from inside the bar: the copy that follows the
// pointer while dragging is put outside the bar, and must still look the part.
// Its spacing is padding inside its border box, with the visuals on .box, so
// that copy (sized from the border box) matches and nothing shifts.
const StyledTab = styled.div`
  display: flex;
  flex-shrink: 1;
  box-sizing: border-box;
  min-width: 0;
  max-width: 222px;
  padding: 0 1px;
  cursor: default;
  -webkit-app-region: no-drag;

  > .box {
    display: flex;
    align-items: center;
    gap: 7px;
    box-sizing: border-box;
    min-width: 0;
    flex-grow: 1;
    height: 26px;
    padding: 0 6px 0 10px;
    border-radius: 7px;
    color: ${colors.textSecondary()};

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }

    > .kept {
      display: flex;
      flex-shrink: 0;
      color: ${colors.textSecondary()};

      > svg {
        width: 11px;
        height: 11px;
      }
    }

    > .title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: ${fonts.display({ size: 12 })};
    }

    > .close {
      display: flex;
      padding: 2px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      opacity: 0;

      > svg {
        width: 13px;
        height: 13px;
      }

      &:hover {
        background: ${colors.buttonBackgroundGlow()};
      }
    }

    &:hover > .close {
      opacity: 0.7;
    }
  }

  &[data-active="true"] > .box {
    background: ${colors.linkActiveBackground()};
    color: ${colors.text()};

    > .close {
      opacity: 0.7;
    }
  }

  &[data-dragging="true"] > .box {
    background: ${colors.textBackgroundPanel()};
    color: ${colors.text()};
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
  }

  ${coarsePointer(`
    > .box {
      height: 38px;
      gap: 8px;
      padding: 0 4px 0 12px;
      border-radius: 10px;

      > .title {
        font-size: 14px;
      }

      /* No hover to show it: the tab you're on has it. */
      > .close {
        padding: 6px;
        border-radius: 8px;

        > svg {
          width: 16px;
          height: 16px;
        }
      }
    }

    &[data-active="true"] > .box > .close {
      opacity: 0.7;
    }
  `)}
`;

const TabDropTarget = styled.div`
  flex-shrink: 0;
  align-self: center;
  width: var(--target-width, 0px);
  height: 26px;
  border-radius: 7px;
  -webkit-app-region: no-drag;

  &[data-draggable-hover="true"] {
    background: ${colors.buttonBackgroundGlow()};
  }
`;
