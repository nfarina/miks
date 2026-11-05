import { AlignLeft, Sidebar } from "lucide-react";
import {
  CSSProperties,
  HTMLAttributes,
  isValidElement,
  ReactNode,
  use,
  useEffect,
  useRef,
} from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors";
import { fonts } from "../../fonts/fonts";
import { flattenChildren } from "../../hooks/flattenChildren";
import { HostContext } from "../../host/context/HostContext";
import { tooltip } from "../../modals/popup/TooltipView";
import { StyledUnreadBadge, UnreadBadge } from "../../router/tabs/UnreadBadge.js";
import { safeAreaCorners, safeAreaTopBar } from "../../safearea/safeArea";
import { AutoBorderView, BorderVisibility } from "../AutoBorderView";
import { barStripPill } from "../BarStrip";
import { Button, StyledButton } from "../Button";
import { NewSiteContext, shouldRenderAccessory } from "./NewSiteContext";

export function NewSiteHeader({
  title,
  ellipsizeTitle = true,
  subtitle,
  accessories,
  hideSiteAccessory,
  style,
  borderVisibility = "auto",
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  title?: ReactNode;
  /** Whether to ellipsize the title. Some custom title components don't support our auto-truncation. Default true. */
  ellipsizeTitle?: boolean;
  subtitle?: ReactNode;
  accessories?: ReactNode;
  hideSiteAccessory?: boolean;
  borderVisibility?: BorderVisibility;
}) {
  const { siteTitle } = use(NewSiteContext);
  const { platform } = use(HostContext);
  const titleRef = useRef<HTMLDivElement>(null);

  // Set document title based on the text content of the title element.
  useEffect(() => {
    const titleText = titleRef.current?.textContent;

    if (siteTitle && titleText) {
      document.title = titleText + " | " + siteTitle;
    } else if (titleText) {
      document.title = titleText;
    } else if (siteTitle) {
      document.title = siteTitle;
    }
  }, [siteTitle, title, subtitle]);

  const {
    isDefaultContext,
    sidebarVisible,
    setSidebarVisible,
    siteLayout,
    siteAccessory,
    sidebarBadge,
  } = use(NewSiteContext);

  // Whether a sidebar sits beside us, taking the window's left edge. A page
  // used outside of a <NewSiteLayout> has no sidebar, whatever the context's
  // defaults say.
  const sidebarDocked = !isDefaultContext && sidebarVisible && siteLayout === "desktop";

  const cssProps = {
    "--accessory-width": (siteAccessory?.size.width ?? 0) + "px",
    "--accessory-height": (siteAccessory?.size.height ?? 0) + "px",
    ...style,
  } as CSSProperties;
  const showSidebarBadge = !!sidebarBadge && (!sidebarVisible || siteLayout === "mobile");

  // In mobile layout, we have space on the left for one "overflow" accessory.
  // Get the list of children in the accessories, if provided, and move the first one to the left.
  let overflowAccessory: ReactNode | undefined;
  const flattenedAccessories = flattenChildren(accessories).filter(isValidElement);
  if (siteLayout === "mobile" && flattenedAccessories.length > 2) {
    overflowAccessory = flattenedAccessories[0];
    accessories = flattenedAccessories.slice(1);
  }

  return (
    <StyledNewSiteHeader
      data-window-drag
      data-site-layout={siteLayout}
      data-sidebar-visible={sidebarVisible}
      data-platform={platform}
      data-sidebar-docked={sidebarDocked}
      data-has-site-accessory={
        !hideSiteAccessory && shouldRenderAccessory(siteAccessory, siteLayout)
      }
      data-has-overflow-accessory={!!overflowAccessory}
      style={cssProps}
      visibility={borderVisibility}
      {...rest}
    >
      <div
        className="sidebar-toggle"
        data-visible={!sidebarVisible || siteLayout === "mobile"}
        inert={sidebarVisible}
      >
        <Button
          newStyle
          icon={siteLayout === "mobile" ? <AlignLeft /> : <Sidebar />}
          onClick={() => setSidebarVisible(!sidebarVisible)}
          {...tooltip("Open sidebar", { hotkey: "ctrl+s" })}
        />
        {showSidebarBadge && <UnreadBadge max={99}>{sidebarBadge}</UnreadBadge>}
      </div>
      {overflowAccessory && <div className="overflow-accessory">{overflowAccessory}</div>}
      <div className="title-left" />
      <div className="page-title" ref={titleRef} data-has-subtitle={!!subtitle}>
        <div className="title" data-ellipsize={!!ellipsizeTitle}>
          {title}
        </div>
        {subtitle && <div className="subtitle">{subtitle}</div>}
      </div>
      <div className="title-right" />
      <div className="accessories">{accessories}</div>
    </StyledNewSiteHeader>
  );
}

export const StyledNewSiteHeader = styled(AutoBorderView)`
  display: flex;
  flex-flow: row;
  align-items: center;
  padding: 8px 10px;
  /* Clear of whatever runs down the sides, like the iPhone Duo's status bar
     strip or an iPhone's notch in landscape. */
  padding-left: ${safeAreaTopBar.left("10px")};
  padding-right: ${safeAreaTopBar.right("10px")};
  box-sizing: border-box;
  position: relative;

  > * {
    flex-shrink: 0;
  }

  > .sidebar-toggle {
    display: flex;
    flex-flow: row;
    align-items: center;
    justify-content: flex-start;
    min-width: 40px;
    min-height: 40px;
    width: 40px;
    transition: width 0.2s ease-in-out;
    position: relative;

    > ${StyledButton} {
      svg {
        width: 22px;
        height: 22px;
      }
    }

    &[data-visible="false"] {
      width: 0;
      min-width: 0;
      overflow: hidden;
    }

    > ${StyledUnreadBadge} {
      position: absolute;
      top: 0px;
      left: 22px;
      box-shadow: 0 0 0 2px ${colors.textBackground()};

      @media (prefers-color-scheme: dark) {
        box-shadow: 0 0 0 2px ${colors.textBackgroundPanel()};
      }
    }
  }

  > .page-title {
    padding: 5px 7px;
    transition: margin-left 0.2s ease-in-out;
    flex-shrink: 1;
    color: ${colors.text()};
    font: ${fonts.display({ size: 22 })};
    position: relative;
    top: -1px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    > .title {
      &[data-ellipsize="true"] {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }

    > .subtitle {
      font: ${fonts.display({ size: 11, line: "14px" })};
      margin-bottom: -3px;
      color: ${colors.textSecondary()};
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    &[data-has-subtitle="true"] {
      white-space: normal;
      overflow: visible;
      text-overflow: unset;

      > .title {
        font: ${fonts.display({ size: 17, line: "20px" })};
        margin-bottom: -3px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
    }
  }

  > .title-right {
    flex-grow: 1;
  }

  > .accessories {
    margin-left: 10px;
    padding-right: 5px;
    box-sizing: border-box;
    display: flex;
    flex-flow: row;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;

    > * {
      flex-shrink: 0;
    }
  }

  &[data-has-site-accessory="true"] {
    > .accessories {
      padding-right: calc(var(--accessory-width) + 10px + 5px);
    }
  }

  &[data-site-layout="desktop"][data-sidebar-visible="true"] {
    > .page-title {
      margin-left: -5px;
    }
  }

  /* In the Mac app, we look like a NavLayout's header does there (see
     StyledNavHeader): as tall, with its buttons as far from the top and the
     right edge, a window-sized title, and floating buttons. */
  &[data-platform="macOS"] {
    padding: 12px 11px 10px 10px;

    > .page-title {
      font: ${fonts.displayBold({ size: 15, line: "1.2" })};
      top: 0;
      /* The title truncates itself, and clipping here would cut off the
         shadow of a floating button inside a custom title. */
      overflow: visible;

      > .subtitle {
        font: ${fonts.display({ size: 11, line: "1.2" })};
        margin-bottom: 0;
      }

      &[data-has-subtitle="true"] > .title {
        font: ${fonts.displayBold({ size: 15, line: "1.2" })};
        margin-bottom: 0;
      }
    }

    > .accessories > ${StyledButton}[data-new-style="true"] {
      ${barStripPill}
      min-width: 40px;
      min-height: 40px;
      border: none;

      > .icon > svg {
        width: 20px;
        height: 20px;
      }

      &[data-primary="true"] {
        background: ${colors.primary()};
        color: ${colors.white()};
      }
    }
  }

  /* A Mac window's traffic lights sit in the top-left corner, which the host
     reports as a corner inset (see StyledNavHeader, which does the same), and
     we keep as clear of them as its buttons do. Not while the sidebar is
     docked beside us, though: then it has the corner. */
  &[data-platform="macOS"][data-sidebar-docked="false"] {
    padding-left: ${safeAreaCorners.left("19px")};
  }

  &[data-site-layout="mobile"] {
    padding-top: 5px;
    padding-bottom: 5px;

    > .sidebar-toggle {
      /* Match accessories width to center the title. */
      width: 90px;
    }

    &[data-has-overflow-accessory="true"] {
      > .sidebar-toggle {
        width: unset;
      }
    }

    > .overflow-accessory {
      margin-right: 10px;
    }

    > .title-left {
      flex-grow: 1;
    }

    > .page-title {
      text-align: center;
    }

    > .accessories {
      width: 90px;
      padding-right: 0;
      gap: 5px;
    }
  }
`;
