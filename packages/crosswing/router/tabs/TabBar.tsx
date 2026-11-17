import { ReactElement, use } from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { barStripPill } from "../../components/BarStrip.js";
import { HostContext } from "../../host/context/HostContext.js";
import { safeArea } from "../../safearea/safeArea.js";
import { StyledTabLink, TabLink, TabProps } from "./TabLink.js";
import { StyledUnreadBadge } from "./UnreadBadge.js";

/**
 * How the tab bar presents itself, picked by <Tabs> from the host's layout:
 *
 * - `bottom`: A bar along the bottom, icons over titles (iPhone portrait).
 * - `bottom-inline`: A shorter bar along the bottom, icons beside titles, for
 *   compact heights and wide screens (iPhone and iPad in landscape).
 * - `strip`: Icons only, at the bottom of the system's vertical control strip
 *   (iPhone Duo, closed or open).
 */
export type TabBarPresentation = "bottom" | "bottom-inline" | "strip";

export function TabBar({
  tabs,
  selectedTab,
  presentation = "bottom",
  getTabLink,
  onReselect,
}: {
  tabs: ReactElement<TabProps>[];
  selectedTab: ReactElement<TabProps>;
  presentation?: TabBarPresentation;
  getTabLink: (tab: ReactElement<TabProps>) => string;
  /** A tap on the current tab, at its root, with nothing to scroll home. */
  onReselect?: (tab: ReactElement<TabProps>, target: HTMLElement) => void;
}) {
  const { container } = use(HostContext);

  return (
    <StyledTabBar
      data-container={container}
      data-presentation={presentation}
    >
      {tabs.map((tab) => (
        <TabLink
          key={tab.props.path}
          to={getTabLink(tab)}
          active={tab === selectedTab}
          tab={tab}
          onReselect={(target) => onReselect?.(tab, target)}
        />
      ))}
    </StyledTabBar>
  );
}

export const StyledTabBar = styled.div`
  box-sizing: border-box;
  display: flex;
  align-items: center;

  /* Short, with titles beside the icons. */
  &[data-presentation="bottom-inline"] {
    > ${StyledTabLink} {
      flex-flow: row;
      gap: 6px;

      > .text {
        margin-top: 0;
        font-size: 13px;
      }

      /* On the icon's corner, clear of the title beside it. */
      > ${StyledUnreadBadge} {
        top: 0;
        left: 16px;
      }
    }
  }

  /* A capsule over the content, like iOS's tab bars since iOS 26. */
  &[data-presentation="bottom"],
  &[data-presentation="bottom-inline"] {
    ${barStripPill}
    border-radius: calc(var(--tab-bar-height) / 2);
    height: var(--tab-bar-height);
    padding: 4px;
    gap: 2px;

    /* Each tab is as wide as it needs, with a floor so short titles still
       make a comfortable target. */
    > ${StyledTabLink} {
      flex: none;
      min-width: 64px;
      align-self: stretch;
      justify-content: center;
      padding: 0 12px;
      box-sizing: border-box;
      border-radius: calc((var(--tab-bar-height) - 8px) / 2);

      &[data-active="true"] {
        background: ${colors.primary({ alpha: 0.12 })};
      }
    }

    /* Short, with titles beside the icons. */
    &[data-presentation="bottom-inline"] {
      gap: 2px;

      > ${StyledTabLink} {
        padding: 0 14px;
      }
    }
  }

  /* A small pill inside the strip the system reserves for bars. */
  &[data-presentation="strip"] {
    flex-flow: column;
    justify-content: flex-end;
    gap: 4px;
    padding: 4px 0;
    ${barStripPill}

    > ${StyledTabLink} {
      width: 36px;
      height: 36px;
      padding: 0;
      justify-content: center;
      border-radius: 18px;

      &[data-active="true"] {
        background: ${colors.primary({ alpha: 0.12 })};
      }

      > .text {
        display: none;
      }

      > ${StyledUnreadBadge} {
        top: -2px;
        left: auto;
        right: -4px;
      }
    }
  }
`;
