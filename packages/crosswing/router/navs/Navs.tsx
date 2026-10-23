import Debug from "debug";
import {
  createRef,
  HTMLAttributes,
  isValidElement,
  ReactElement,
  ReactNode,
  use,
  useEffect,
  useState,
} from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { NoContent } from "../../components/NoContent.js";
import { flattenChildren } from "../../hooks/flattenChildren.js";
import { BarEdgeContext } from "../../host/context/BarEdgeContext.js";
import { HostContext } from "../../host/context/HostContext.js";
import { getFold, whenFolded } from "../../host/util/fold.js";
import { provideSafeArea } from "../../safearea/safeArea.js";
import { useViewportSize, viewportContainer } from "../../viewport/viewport.js";
import { RouterContext, RouterContextValue } from "../context/RouterContext.js";
import { Redirect } from "../redirect/Redirect.js";
import { MatchParams, RouterLocation } from "../RouterLocation.js";
import { NavStack, NavStackAnimation, NavStackItem, StyledNavs } from "./NavStack.js";

export * from "./NavAccessoryView.js";
export * from "./NavLayout.js";
export * from "./NavStack.js";
export * from "./NavTitleView.js";
export * from "./scrollEdge.js";

const debug = Debug("router:Navs");

export type NavAnimation = NavStackAnimation;

export interface NavRouteProps<Path extends string = any> {
  path?: Path;
  render: (params: MatchParams<Path>) => ReactElement;
  /**
   * In split <Navs>, this page takes the whole screen while it's on top,
   * hiding the root's pane (a recipe, say, that wants the room).
   */
  fullScreen?: boolean;
}

export function Navs({
  children,
  animation,
  preloadHistory = true,
  split,
  placeholder,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  children: ReactNode;
  animation?: NavAnimation;
  preloadHistory?: boolean;
  /**
   * With room for it (see useRoomToSplit), shows the root page in a pane on
   * the left and the pages it leads to in a stack on the right, like Settings
   * on an iPad. Opening another page the root links to starts the right-hand
   * stack over.
   */
  split?: boolean;
  /** What the right-hand pane shows before anything's been opened. */
  placeholder?: ReactNode;
}) {
  // Coerce children to array, flattening fragments and falsy conditionals.
  const routes = flattenChildren(children).filter(isNavRoute);

  // Pull our route information from context.
  const { location: rawLocation, nextLocation, history, parent, flags } = use(RouterContext);

  // A `replace` navigation (e.g. <Redirect>, or history.navigate(to, { replace:
  // true })) should swap the top of our stack rather than push a new entry, so
  // the replaced page leaves the back stack — matching history.replaceState
  // semantics. The intent rides on the location from the history event; we read
  // it here and then work with a cleaned copy so the flag never leaks into our
  // stored history or into child route contexts (which would otherwise confuse
  // a nested <Navs> into replacing its own top on first render).
  const replace = !!rawLocation.replace;
  const location = replace ? rawLocation.clone({ replace: undefined }) : rawLocation;

  const selected = selectRoute(routes, location);
  const root = selectRoot(routes, location);
  const isRootSelected = !selected.route.props.path;

  const splitView = useRoomToSplit() && !!split;

  // The host as it is outside any split pane, for full-screen pages.
  const host = use(HostContext);

  // Construct our storage for previous routes on this nav.
  const [previousLocations, setPreviousLocations] = useState<RouterLocation[]>(() =>
    preloadHistory ? getPreviousLocations(routes, location, root.location) : [],
  );

  debug(
    `Render <Navs> with location "${location}" and next location "${nextLocation}" and previous locations: ${previousLocations}`,
  );

  // Construct the new list of locations to render.
  // If we are displaying the default route, erase history (because there
  // shouldn't be any way to go back further, and also as a safety valve).
  const allLocations = isRootSelected
    ? [location]
    : splitView && isTopLevel(routes, location, root.location)
      ? [root.location, location]
      : pushLocation(root.location, previousLocations, location, replace);

  // Pages you've gone back from, the latest last, to go forward to again.
  const [forwardLocations, setForwardLocations] = useState<RouterLocation[]>([]);

  // A page's key normally comes from where it is, so a new place is a new
  // page. But a replace that stays on the same route (another day from a
  // week strip, say) keeps the page it replaced, showing the new place, rather
  // than animating one page out and another in. These are the pages keeping
  // an older place's key, by their href.
  const [keptKeys, setKeptKeys] = useState<Record<string, string>>({});

  function getKeyName(saved: RouterLocation, kept: Record<string, string>): string {
    return kept[saved.href()] ?? selectRoute(routes, saved).location.claimedHref();
  }

  const replaced = previousLocations.at(-1);
  const keepsPage =
    replace &&
    !!replaced &&
    !replaced.equals(location) &&
    selectRoute(routes, replaced).route.props.path === selected.route.props.path;
  const currentKeptKeys = keepsPage
    ? { ...keptKeys, [location.href()]: getKeyName(replaced!, keptKeys) }
    : keptKeys;

  // Store the list of locations we rendered.
  useEffect(() => {
    setPreviousLocations(allLocations);
    setForwardLocations(getForwardLocations(previousLocations, allLocations, forwardLocations));
    // Only what's still on the stack.
    const hrefs = new Set(allLocations.map((saved) => saved.href()));
    setKeptKeys(
      Object.fromEntries(Object.entries(currentKeptKeys).filter(([href]) => hrefs.has(href))),
    );
  }, [location.href()]);

  if (selected.redirect) {
    console.warn(
      `No routes exactly matched location "${location}". Redirecting to "${selected.location}"`,
    );
    return <Redirect to={selected.location.href()} />;
  }

  debug(`Rendering locations: ${allLocations}`);

  // Whether the page on top wants the whole screen (see NavRouteProps).
  const top = allLocations[allLocations.length - 1];
  const fullScreen = splitView && !!selectRoute(routes, top).route.props.fullScreen;

  function getNavStackItem(savedLocation: RouterLocation, index: number): NavStackItem {
    const { route, location: childLocation } = selectRoute(routes, savedLocation);
    const itemFullScreen = splitView && index > 0 && !!route.props.fullScreen;
    // Split, the first page on the right has the root beside it, not behind
    // (unless it covers the root, full screen).
    const besideRoot = splitView && index === 1 && !itemFullScreen;
    const backLocation = besideRoot ? undefined : allLocations[index - 1];

    // Get the next location in the universe of these <Navs>.
    const { location: nextChildLocation } = selectRoute(routes, nextLocation);

    const childContext: RouterContextValue = {
      location: childLocation,
      nextLocation: nextChildLocation,
      history,
      flags,
      ...(parent ? { parent } : null),
      ...(backLocation ? { back: backLocation.href() } : null),
      ...(besideRoot ? { besideRoot } : null),
    };

    const child = route.props.render(childLocation.params);

    return {
      key: index + " - " + getKeyName(savedLocation, currentKeptKeys),
      childContext,
      // A full-screen page gets back the fold its pane hides.
      child: itemFullScreen ? <HostContext value={host}>{child}</HostContext> : child,
      ref: createRef(),
      fullScreen: itemFullScreen,
    };
  }

  // Figure out where to go if you swipe right on the nav stack.
  const back = allLocations[allLocations.length - 2];
  const items = allLocations.map(getNavStackItem);

  // And left: the page you last came back from, ready just off-screen, in
  // the place it'll take on the stack (so it's the same element once there).
  // (Not if you've just gone there, before the effect below catches up.)
  const forwardLocation = forwardLocations
    .at(-1)
    ?.equals(top, { excludeSearch: true })
    ? undefined
    : forwardLocations.at(-1);
  const forward = forwardLocation
    ? { location: forwardLocation, item: getNavStackItem(forwardLocation, allLocations.length) }
    : null;

  if (splitView) {
    const [rootItem, ...detailItems] = items;

    return (
      <StyledSplitNavs {...rest}>
        <SplitPane className="primary" primary>
          <NavStack back={null} items={[rootItem]} animation="none" />
        </SplitPane>
        <SplitPane className="secondary">
          {detailItems.length > 0 ? (
            // Keyed by the page the root opened, so switching to another one
            // swaps the stack outright instead of pushing onto it.
            <NavStack
              key={detailItems[0].childContext.location.href({ excludeSearch: true })}
              back={allLocations.length > 2 || fullScreen ? back : null}
              items={detailItems}
              animation={animation}
            />
          ) : (
            // Defaulted here rather than in the parameter list — React
            // Compiler can't reorder a JSX default value.
            (placeholder ?? <NoContent title="Nothing selected" />)
          )}
        </SplitPane>
      </StyledSplitNavs>
    );
  }

  return (
    <NavStack back={back} forward={forward} items={items} animation={animation} {...rest} />
  );
}

/**
 * The pages to go forward to, after moving from `previous` to `current`:
 * going back saves the page you left, going forward spends it, and going
 * anywhere else forgets them, as in a browser.
 */
export function getForwardLocations(
  previous: RouterLocation[],
  current: RouterLocation[],
  forward: RouterLocation[],
): RouterLocation[] {
  const same = (a: RouterLocation | undefined, b: RouterLocation | undefined) =>
    !!a && !!b && a.equals(b, { excludeSearch: true });

  const wentBack =
    current.length === previous.length - 1 && current.every((location, i) => same(location, previous[i]));
  if (wentBack) return [...forward, previous[previous.length - 1]];

  const wentForward =
    current.length === previous.length + 1 && same(current.at(-1), forward.at(-1));
  if (wentForward) return forward.slice(0, -1);

  // The same page again (a new search string, say).
  if (current.length === previous.length && same(current.at(-1), previous.at(-1))) return forward;

  return [];
}

/**
 * Whether there's room for split <Navs>: a regular-width screen at least
 * 700px wide (an iPad, or an iPhone Duo open or in the book pose), where
 * Settings on iOS splits too. Without a host to ask, a wide window.
 */
function useRoomToSplit(): boolean {
  const { layout } = use(HostContext);
  const viewport = useViewportSize();

  if (getFold(layout)) return true;
  if (layout) return layout.sizeClass.horizontal === "regular" && layout.width >= 700;
  return viewport.width >= 900;
}

/**
 * One side of split <Navs>. Each is a screen of its own to what's inside:
 * width-dependent styles respond to the pane, there's no fold running through
 * it, and only the right-hand pane puts its controls in the bar strip.
 */
function SplitPane({ primary, ...rest }: HTMLAttributes<HTMLDivElement> & { primary?: boolean }) {
  const host = use(HostContext);
  const barEdge = use(BarEdgeContext);
  const layout = host.layout && { ...host.layout, divisions: [] };

  return (
    <HostContext value={{ ...host, layout }}>
      <BarEdgeContext value={primary ? null : barEdge}>
        <div {...rest} />
      </BarEdgeContext>
    </HostContext>
  );
}

export const StyledSplitNavs = styled.div`
  position: relative;
  display: flex;
  flex-flow: row;
  overflow: hidden;

  /* Where the right-hand pane starts (past the left one and its hairline),
     and what the panes hide from their pages, kept for full-screen ones. */
  --split-detail-left: 361px;
  --split-safe-area-left: var(--safe-area-left);
  --split-safe-area-corner-left: var(--safe-area-corner-left);
  --split-fold: var(--fold);

  > .primary,
  > .secondary {
    position: relative;
    display: flex;
    flex-flow: column;
    ${viewportContainer}
    --fold: none;

    > * {
      height: 0;
      flex-grow: 1;
    }
  }

  > .primary {
    flex: none;
    width: 360px;
    border-right: 1px solid ${colors.separator()};
    ${provideSafeArea({ right: "0px" })}

    /* The page open on the right. */
    a[data-prefix-active="true"] {
      background: ${colors.buttonBackgroundHover()};
    }
  }

  > .secondary {
    flex: 1;
    min-width: 0;
    ${provideSafeArea({ left: "0px" })}

    /* A full-screen page breaks out of its pane to cover the whole screen,
       the root's pane included, so it slides in over both like any other
       page, and gets back the screen's width, left edge, and fold. */
    > ${StyledNavs} {
      overflow: visible;

      > .item[data-full-screen="true"] {
        left: calc(-1 * var(--split-detail-left));
        ${viewportContainer}
        --safe-area-left: var(--split-safe-area-left);
        --safe-area-corner-left: var(--split-safe-area-corner-left);
        --fold: var(--split-fold);
      }
    }
  }

  /* The fold divides the panes. */
  ${whenFolded(`
    --split-detail-left: var(--fold-right);

    > .primary {
      width: var(--fold-left);
      border-right: none;
    }

    > .secondary {
      margin-left: calc(var(--fold-right) - var(--fold-left));
    }
  `)}
`;

/** Whether a location is a page the root leads to directly. */
function isTopLevel(
  routes: ReactElement<NavRouteProps>[],
  location: RouterLocation,
  root: RouterLocation,
): boolean {
  return getPreviousLocations(routes, location, root).length === 1;
}

interface SelectedRoute {
  route: ReactElement<NavRouteProps>;
  location: RouterLocation;
  redirect?: boolean;
}

function selectRoot(
  routes: ReactElement<NavRouteProps>[],
  location: RouterLocation,
): SelectedRoute {
  const root = routes.find((route) => !route.props.path);

  if (!root) {
    throw new Error(
      "You must include at least a <NavRoute> with an empty path to serve as the default.",
    );
  }

  return { route: root, location: location.rewrite("") };
}

function selectRoute(
  routes: ReactElement<NavRouteProps>[],
  location: RouterLocation,
): SelectedRoute {
  // Look through all routes and attempt to match.
  for (const route of routes) {
    const path = route.props.path;
    const childLocation = location.tryClaim(path || "");

    // If we matched the path completely with nothing leftover, we found it.
    if (childLocation && !childLocation.unclaimedPath()) {
      debug(`Selecting <NavRoute> with path: ${path || "/"}`);
      return { route, location: childLocation };
    }
  }

  // Redirect to the root route by default.
  return { ...selectRoot(routes, location), redirect: true };
}

/**
 * Gets the initial history of locations to render, excluding the current
 * location. Basically, if you "start" on some route deeper than the root, we'd
 * like to have the "back" stack preloaded for you so you don't just go
 * straight back to the root from somewhere deeper in the nav tree.
 */
function getPreviousLocations(
  routes: ReactElement<NavRouteProps>[],
  location: RouterLocation,
  root: RouterLocation,
): RouterLocation[] {
  let testLocation = location;
  const locations: RouterLocation[] = [];

  while (true) {
    // Chop off the last segment of the path.
    const newSegments = testLocation.unclaimedSegments().slice(0, -1);

    if (newSegments.length === 0) {
      break;
    }

    testLocation = testLocation.rewrite(newSegments.join("/"), {
      preserveClaimIndex: true,
    });

    if (testLocation.equals(root, { excludeSearch: true })) {
      break;
    }

    // If we've found a route that matches, insert it at the front of the list.
    const maybeMatched = selectRoute(routes, testLocation);
    if (
      maybeMatched.route &&
      (maybeMatched.route.props.path?.split("/")?.length ?? 0) ===
        testLocation.unclaimedSegments().length
    ) {
      locations.unshift(testLocation);
    }
  }

  locations.unshift(root);
  return locations;
}

export function pushLocation(
  root: RouterLocation,
  previous: RouterLocation[],
  current: RouterLocation,
  replace: boolean = false,
): RouterLocation[] {
  // If this is the first place we're landing on, make sure you can go
  // back to the root.
  if (previous.length === 0) {
    return [root, current];
  }

  const lastLocation = previous[previous.length - 1];
  const penultimateLocation = previous[previous.length - 2];

  // If we're already at this location, replace it with the new one (in case
  // the search string changed). This also keeps re-renders idempotent once a
  // replace navigation (below) has been recorded into our history.
  if (lastLocation?.equals(current, { excludeSearch: true })) {
    return [...previous.slice(0, previous.length - 1), current];
  }

  // Reached via a replace navigation (e.g. <Redirect>)? Swap the current top
  // for the new location instead of pushing, so the page being replaced leaves
  // the back stack. Guarded to never replace away the root, so there's always
  // somewhere to go back to.
  if (replace && previous.length > 1) {
    return [...previous.slice(0, previous.length - 1), current];
  }

  // If you are navigating to the location just before the last one, we
  // assume you are going "back".
  if (penultimateLocation?.equals(current, { excludeSearch: true })) {
    return [...previous.slice(0, previous.length - 2), current];
  }

  // Just add it on to the end like usual.
  return [...previous, current];
}

export function NavRoute<Path extends string>({}: NavRouteProps<Path>) {
  // Our own render method is never called.
  return null;
}
// We use this instead of comparing item.type === NavRoute because that class
// pointer is not stable during development with hot reloading.
NavRoute.isNavRoute = true;

function isNavRoute(item: ReactNode): item is ReactElement<NavRouteProps> {
  return isValidElement(item) && !!item.type?.["isNavRoute"];
}
