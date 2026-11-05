import Debug from "debug";
import {
  HTMLAttributes,
  ReactElement,
  ReactNode,
  RefObject,
  isValidElement,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { easing } from "../../shared/easing.js";
import { flattenChildren } from "../../hooks/flattenChildren.js";
import { useElementSize } from "../../hooks/useElementSize.js";
import { BarEdgeContext } from "../../host/context/BarEdgeContext.js";
import { HostContext } from "../../host/context/HostContext.js";
import { SizeClasses, sizeClassesForSize } from "../../host/util/sizeClass.js";
import { HostLayout } from "../../host/util/types.js";
import { provideSafeArea, safeArea } from "../../safearea/safeArea.js";
import { RouterLocation } from "../RouterLocation.js";
import { RouterContext } from "../context/RouterContext.js";
import { StyledNavs } from "../navs/NavStack.js";
import { Redirect } from "../redirect/Redirect.js";
import { StyledTabBar, TabBar, TabBarPresentation } from "./TabBar.js";
import { TabProps } from "./TabLink.js";
import { TabsContext } from "./TabsContext.js";
import { TabReselectContext, TabReselectHandler } from "./useTabReselect.js";

export * from "./TabBar.js";
export * from "./TabLink.js";
export * from "./TabsContext.js";
export * from "./UnreadBadge.js";
export * from "./useTabReselect.js";

const debug = Debug("router:Tabs");

export function Tabs({
  children,
  floating,
  ...rest
}: {
  children: ReactNode;
  /**
   * Float the bar along the bottom as a capsule over the content, like iOS's
   * tab bars since iOS 26, instead of a bar that claims its own space. Pages
   * are kept clear of it (see TabsContext), unless their NavLayout extends
   * under bars, in which case their content scrolls on behind it.
   */
  floating?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  // Coerce children to array, flattening fragments and falsy conditionals.
  const tabs = flattenChildren(children).filter(isTab);

  // Pull our route information from context.
  const { location, nextLocation, history, parent, flags } = use(RouterContext);

  // Grab the viewport information from our native host so we can hide
  // the tab bar if the keyboard is visible, and its layout so we can present
  // the tab bar to suit the device and pose.
  const { viewport, container, layout } = use(HostContext);
  const barEdge = use(BarEdgeContext);

  // Without a host reporting size classes (in a browser), approximate them
  // from our own size.
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useElementSize(ref, setSize);

  const { width, height } = layout ?? size;

  const presentation = getTabBarPresentation({
    sizeClass: layout?.sizeClass ?? sizeClassesForSize(size),
    barEdge,
    landscape: width > height,
  });

  // Construct our storage for inactive tabs.
  const [tabLocations] = useState(() => new Map<string, RouterLocation>());

  // Where each tab's root page can leave a handler for taps on its own tab.
  const [reselectHandlers] = useState(
    () => new Map<string, RefObject<TabReselectHandler | null>>(),
  );

  function getReselectHandler(tabPath: string): RefObject<TabReselectHandler | null> {
    let handler = reselectHandlers.get(tabPath);
    if (!handler) reselectHandlers.set(tabPath, (handler = { current: null }));
    return handler;
  }

  debug(`Render <Tabs> with location "${location}" and next location "${nextLocation}"`);

  // The tab that will be selected next, regardless of whether it is loaded.
  const nextSelected = selectTab(tabs, nextLocation);

  // The "deferred" contents we are rendering currently.
  const selected = selectTab(tabs, location);
  const { path } = selected.tab.props;

  // Update the path of our currently selected tab.
  useEffect(() => {
    if (!selected.redirect) {
      tabLocations.set(path, selected.location);
    }
  });

  //
  // Render
  //

  if (selected.redirect) {
    debug(`Location does not match any tabs. Redirecting to "${path}"`);
    return <Redirect to={selected.location.href()} />;
  }

  debug(`Render <Tabs> with child location "${selected.location}"`);

  function getTabLink(tab: ReactElement<TabProps>): string {
    const tabLocation = tabLocations.get(tab.props.path);

    // If we've visited this tab before, and we're not currently viewing it,
    // then when the user clicks it, they should be taken back to whatever
    // "deep" content they had navigated to previously.
    if (tabLocation && tab !== selected.tab) return tabLocation.href();

    // Link to the root path, unless the user wants a specific path here.
    const parts: string[] = [];
    if (tab.props.path) {
      parts.push(tab.props.path);
    }

    // Only include the initial path if we're not already on this tab.
    // Otherwise we always want tapping the tab to go back to the root.
    if (tab.props.initialPath && tab !== selected.tab) {
      parts.push(tab.props.initialPath);
    }

    return location.linkTo(parts.join("/"));
  }

  function renderTabContents(tab: ReactElement<TabProps>): ReactNode {
    const { path: tabPath, render } = tab.props;

    const isSelected = tab === selected.tab;
    const childLocation = isSelected ? selected.location : tabLocations.get(tabPath);

    const isNextSelected = tab === nextSelected.tab;
    const nextChildLocation = isNextSelected ? nextSelected.location : tabLocations.get(tabPath);

    // Do we have a current or old location for this tab? Render it if so.
    if (childLocation && nextChildLocation) {
      const childContext = {
        history,
        location: childLocation,
        nextLocation: nextChildLocation,
        parent,
        flags,
      };
      const className = isSelected ? "active" : "inactive";

      return (
        <TabContent key={childLocation.claimedHref()} className={className}>
          <TabReselectContext value={getReselectHandler(tabPath)}>
            <RouterContext value={childContext}>{render()}</RouterContext>
          </TabReselectContext>
        </TabContent>
      );
    }

    // Render a placeholder until the users visits this tab.
    return <TabContent key={tabPath} className="inactive" />;
  }

  // No longer auto-collapsing the tab bar on android. It's just worse. I don't
  // care if it's the "android way".
  // const atTabRoot = location.unclaimedPath() === selected.tab.props.path;

  // const collapsed = viewport.keyboardVisible; //|| (container === "android" && !atTabRoot);

  // Keyboard detection isn't working well on some Android devices.
  // (Outdated comment - we're trying it again anyway!) A bar along the bottom
  // would ride up on the keyboard, so we hide it. So does the strip, since
  // the keyboard leaves it too short to hold the tabs and the nav's buttons.
  const collapsed = /*container !== "android" &&*/ !!viewport.keyboardVisible;

  const floatingBar = !!floating && presentation.startsWith("bottom") && !collapsed;

  return (
    <StyledTabs
      ref={ref}
      data-container={container}
      data-collapsed={collapsed}
      data-floating={floatingBar}
      data-presentation={presentation}
      data-bar-edge={barEdge ?? undefined}
      {...rest}
    >
      <TabsContext value={{ floatingTabBar: floatingBar }}>
        {tabs.map(renderTabContents)}
      </TabsContext>
      <TabBar
        tabs={tabs}
        selectedTab={nextSelected.tab}
        presentation={presentation}
        floating={floatingBar}
        getTabLink={getTabLink}
        onReselect={(tab, target) => getReselectHandler(tab.props.path).current?.(target)}
      />
    </StyledTabs>
  );
}

/**
 * Picks how to present the tab bar from the size classes and the edge where
 * the system wants bars (if any).
 */
export function getTabBarPresentation({
  sizeClass,
  barEdge,
  landscape,
}: {
  sizeClass: SizeClasses;
  barEdge?: HostLayout["barEdge"] | null;
  landscape?: boolean;
}): TabBarPresentation {
  // The system runs bars vertically along one edge (iPhone Duo, closed or
  // open). Tabs stay in that strip as the Duo opens and closes, so they don't
  // jump around the screen.
  if (barEdge) return "strip";

  // Room to spare (iPad): a bar along the bottom, the same as on iPhone, and
  // the shorter one in landscape, where height is scarcer than width.
  if (sizeClass.horizontal === "regular" && sizeClass.vertical === "regular") {
    return landscape ? "bottom-inline" : "bottom";
  }

  // Short (iPhone landscape).
  if (sizeClass.vertical === "compact") return "bottom-inline";

  return "bottom";
}

interface SelectedTab {
  tab: ReactElement<TabProps>;
  location: RouterLocation;
  redirect?: boolean;
}

function selectTab(tabs: ReactElement<TabProps>[], location: RouterLocation): SelectedTab {
  // Look to see if the desired path matches any of our child tabs.
  for (const tab of tabs) {
    const tabPath = tab.props.path;
    const childLocation = location.tryClaim(tabPath);

    if (childLocation) {
      return { tab, location: childLocation };
    }
  }

  // Redirect to the first tab by default.
  const firstTab = tabs[0];
  const { path } = firstTab.props;

  return {
    tab: firstTab,
    location: location.rewrite(path),
    redirect: true,
  };
}

export function Tab({}: TabProps) {
  // Our own render method is never called.
  return null;
}
// We use this instead of comparing item.type === Tab because that class pointer
// is not stable during development with hot reloading.
Tab.isTab = true;

function isTab(item: ReactNode): item is ReactElement<TabProps> {
  return isValidElement(item) && !!item.type?.["isTab"];
}

const TabContent = styled.div``;

export const StyledTabs = styled.div`
  position: relative; /* Reset z-index. */
  background: ${colors.textBackground()};
  overflow: hidden;

  --tab-bar-height: 49px;

  &[data-container="android"] {
    --tab-bar-height: 58px;
  }

  &[data-presentation="bottom-inline"] {
    --tab-bar-height: 32px;
  }

  > ${TabContent}.inactive, > ${TabContent}.active {
    z-index: 0;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;

    > * {
      /* For odd cases. */
      max-width: 100%;

      flex-grow: 1;
    }
  }

  /* Bars along the bottom claim their space, and cover the bottom edge so the
     content doesn't need to. */
  &[data-presentation^="bottom"]:not([data-collapsed="true"]):not([data-floating="true"])
  > ${TabContent} {
    bottom: calc(var(--tab-bar-height) + ${safeArea.bottom()});

    &:not(:has(*[data-hide-tab-bar="true"])) > * {
      ${provideSafeArea({ bottom: "0px" })}
    }
  }

  > ${TabContent}.active {
    /* In case any children want to render above the tab bar. */
    z-index: 2;

    /* Spooky action at a distance. We need to allow NavStack to overflow so it can render above the tabs if desired, but then there's a chance you can see the next NavLayout animating in from the right. So we disable NavStack's overflow:hidden in favor of our own. */
    ${StyledNavs} {
      overflow: visible;
    }
  }

  /* Special data attribute added by <NavLayout>. Our approach to hiding the tab bar used to be complex, but is now simple, we just stretch the content of any <NavLayout> to cover up the tabs. */
  &[data-presentation^="bottom"]:not([data-floating="true"])
  > ${TabContent}.active
  *[data-hide-tab-bar="true"] {
    bottom: calc(0px - var(--tab-bar-height) - ${safeArea.bottom()});
  }

  > ${TabContent}.inactive {
    /* display: none; */ /* Causes images to flash as they are reloaded when switching back to an already-loaded tab. */
    visibility: hidden;
  }

  > ${StyledTabBar} {
    z-index: 1;
    position: absolute;
  }

  &[data-collapsed="true"] > ${StyledTabBar} {
    display: none;
  }

  &[data-presentation^="bottom"] > ${StyledTabBar} {
    left: 0;
    right: 0;
    bottom: 0;
  }

  /* A floating bar hovers over the content, which runs to the bottom edge
     behind it. How much of the content it covers is passed down for the pages
     to keep clear of (see NavLayout). */
  &[data-floating="true"] {
    --tab-bar-height: 62px;
    --floating-tab-bar-bottom: max(12px, calc(${safeArea.bottom()} - 8px));

    &[data-presentation="bottom-inline"] {
      --tab-bar-height: 44px;
    }

    > ${TabContent} > * {
      --floating-tab-bar-height: calc(var(--floating-tab-bar-bottom) + var(--tab-bar-height) + 8px);
    }

    > ${StyledTabBar} {
      z-index: 3;
      /* Hugs its tabs, centered, like iOS's, and never wider than the
         screen allows. */
      left: 50%;
      translate: -50% 0;
      width: max-content;
      max-width: calc(100% - ${safeArea.left()} - ${safeArea.right()} - 40px);
      bottom: var(--floating-tab-bar-bottom);
      transition:
        transform 0.3s ${easing.outCubic},
        opacity 0.3s ${easing.outCubic};
    }

    /* A page that hides the tab bar just sends it away, since it doesn't
       hold any space to give back. That's the page on top, which isn't always
       the last one: a page you came back from waits off-screen after it, to
       swipe forward to (see NavStack), and mustn't keep the bar hidden. */
    &:has(> ${TabContent}.active ${StyledNavs} > .item[data-top="true"] [data-hide-tab-bar="true"])
    > ${StyledTabBar} {
      transform: translateY(calc(100% + var(--floating-tab-bar-bottom)));
      opacity: 0;
      pointer-events: none;
    }
  }

  /* The strip sits in space the system already reserves for bars, over
     whatever runs underneath. */
  &[data-presentation="strip"] > ${StyledTabBar} {
    z-index: 3;
    bottom: var(--bar-strip-bottom, 0px);
    width: var(--bar-strip-width, 44px);
    align-items: center;
  }

  &[data-presentation="strip"]:has(> ${TabContent}.active [data-hide-tab-bar="true"])
  > ${StyledTabBar} {
    display: none;
  }

  &[data-presentation="strip"][data-bar-edge="right"] > ${StyledTabBar} {
    right: var(--bar-strip-edge-inset, 20px);
  }

  &[data-presentation="strip"][data-bar-edge="left"] > ${StyledTabBar} {
    left: var(--bar-strip-edge-inset, 20px);
  }
`;
