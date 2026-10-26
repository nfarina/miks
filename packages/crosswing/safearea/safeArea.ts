export interface SafeArea {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

/**
 * The safe area inset along each edge, as CSS. Pass a length to get the inset
 * plus that much, like a UIKit layout margin: `safeArea.left("10px")` keeps
 * content 10px clear of the safe area, and is just 10px when there's no inset.
 */
export const safeArea = {
  top: (plus?: string) => withPlus("var(--safe-area-top, 0px)", plus),
  right: (plus?: string) => withPlus("var(--safe-area-right, 0px)", plus),
  bottom: (plus?: string) => withPlus("var(--safe-area-bottom, 0px)", plus),
  left: (plus?: string) => withPlus("var(--safe-area-left, 0px)", plus),
};

/**
 * Like safeArea, but also clearing the screen's rounded corners, for chrome
 * that runs along an edge into them (like a nav header along the top when the
 * status bar has moved to the side, as on the iPhone Duo's outer display).
 * Falls back to the plain safe area when the host doesn't report corners.
 */
export const safeAreaCorners = {
  top: (plus?: string) => withPlus("var(--safe-area-corner-top, var(--safe-area-top, 0px))", plus),
  right: (plus?: string) =>
    withPlus("var(--safe-area-corner-right, var(--safe-area-right, 0px))", plus),
  bottom: (plus?: string) =>
    withPlus("var(--safe-area-corner-bottom, var(--safe-area-bottom, 0px))", plus),
  left: (plus?: string) =>
    withPlus("var(--safe-area-corner-left, var(--safe-area-left, 0px))", plus),
};

/**
 * For a bar along the top edge (a header, a tab strip): where the system would
 * put it, which can be higher than the safe area, beside the cameras and the
 * status bar (the iPhone Duo's inner display), with sides kept clear of them.
 * Elsewhere, the plain safe area. Pad the bar's bottom by `below(height)` so
 * what's under it still starts below the safe area, as it would under a bar
 * at the safe area's top.
 */
export const safeAreaTopBar = {
  top: (plus?: string) =>
    withPlus("var(--safe-area-top-bar-top, var(--safe-area-top, 0px))", plus),
  right: (plus?: string) =>
    withPlus("var(--safe-area-top-bar-right, var(--safe-area-right, 0px))", plus),
  left: (plus?: string) =>
    withPlus("var(--safe-area-top-bar-left, var(--safe-area-left, 0px))", plus),
  /** How far a bar of this height, placed by `top()`, must pad its bottom to reach the safe area's. */
  below: (height: string) =>
    `max(0px, calc(var(--safe-area-top, 0px) - var(--safe-area-top-bar-top, var(--safe-area-top, 0px)) - ${height}))`,
};

function withPlus(inset: string, plus?: string) {
  return plus ? `calc(${inset} + ${plus})` : inset;
}

export function getSafeAreaCSS(safeArea: SafeArea) {
  return `
    --safe-area-top: ${safeArea.top};
    --safe-area-bottom: ${safeArea.bottom};
    --safe-area-left: ${safeArea.left};
    --safe-area-right: ${safeArea.right};
  `;
}

/**
 * CSS that redefines the safe area for an element's subtree. A container that
 * has already kept its content clear of some screen edges (a floating dialog,
 * a tab bar, a nav header) should redefine those edges for its children so
 * they don't pad for them a second time. Only the edges you pass change.
 *
 * Apply it to the children, not the container itself, since the container
 * usually still reads the inherited values for its own padding:
 *
 *     > .content {
 *       ${provideSafeArea({ bottom: "0px" })}
 *     }
 */
export function provideSafeArea(edges: Partial<SafeArea>) {
  // The corner-aware insets (see safeAreaCorners) and the top bar's (see
  // safeAreaTopBar) change along with the plain ones, so clearing an edge
  // clears them all.
  return Object.entries(edges)
    .map(
      ([edge, value]) =>
        `--safe-area-${edge}: ${value}; --safe-area-corner-${edge}: ${value}; --safe-area-top-bar-${edge}: ${value};`,
    )
    .join("\n");
}

type SafeAreaEdge = keyof SafeArea;

/**
 * CSS for a page's content container: pads it by the safe area along the given
 * edges and clears those edges for everything inside, so cells, cards, and the
 * like never need to account for them. A page chooses its own edges, and can
 * let something (like a hero image) break back out to the screen edge with
 * ignoreSafeArea().
 *
 *     const PageContent = styled.div`
 *       ${padSafeArea("left", "right")}
 *     `;
 *
 * Pass an object to pad some edges by an extra length on top of the inset
 * (which would otherwise replace any padding of your own on those edges):
 *
 *     ${padSafeArea("left", "right", { top: "10px", bottom: "40px" })}
 */
export function padSafeArea(...args: (SafeAreaEdge | Partial<Record<SafeAreaEdge, string>>)[]) {
  const extra: Partial<Record<SafeAreaEdge, string>> = {};

  for (const arg of args) {
    if (typeof arg === "string")
      extra[arg] ??= undefined; // Just the inset.
    else Object.assign(extra, arg);
  }

  const edges = Object.keys(extra) as SafeAreaEdge[];

  const padding = edges
    .map((edge) => `padding-${edge}: ${safeArea[edge](extra[edge])};`)
    .join("\n");
  const cleared = Object.fromEntries(edges.map((edge) => [edge, "0px"]));

  // Remembered for ignoreSafeArea() below.
  const padded = edges.map((edge) => `--padded-safe-area-${edge}: ${safeArea[edge]()};`).join("\n");

  // Applied to the children: we still need the inherited insets for our own
  // padding, and a custom property can't refer to its own inherited value.
  return `
    ${padding}
    ${padded}
    box-sizing: border-box;

    > * {
      ${provideSafeArea(cleared)}
    }
  `;
}

/**
 * CSS that lets an element inside a padSafeArea() container reach back out to
 * the screen edges, like SwiftUI's ignoresSafeArea(), for backgrounds and
 * images that should run edge to edge. Its own content should keep clear of
 * the edges with paddedSafeArea().
 */
export function ignoreSafeArea(...edges: SafeAreaEdge[]) {
  return edges.map((edge) => `margin-${edge}: calc(-1 * ${paddedSafeArea[edge]()});`).join("\n");
}

/**
 * How much the nearest padSafeArea() container padded along each edge, for
 * content inside an ignoreSafeArea() element to keep clear of the edges again.
 * Takes an optional length to add, like safeArea.
 */
export const paddedSafeArea = {
  top: (plus?: string) => withPlus("var(--padded-safe-area-top, 0px)", plus),
  right: (plus?: string) => withPlus("var(--padded-safe-area-right, 0px)", plus),
  bottom: (plus?: string) => withPlus("var(--padded-safe-area-bottom, 0px)", plus),
  left: (plus?: string) => withPlus("var(--padded-safe-area-left, 0px)", plus),
};

/** For containers that are clear of every screen edge. */
export const NO_SAFE_AREA: SafeArea = {
  top: "0px",
  right: "0px",
  bottom: "0px",
  left: "0px",
};

export const BROWSER_SAFE_AREA: SafeArea = {
  top: "env(safe-area-inset-top, 0px)",
  right: "env(safe-area-inset-right, 0px)",
  bottom: "env(safe-area-inset-bottom, 0px)",
  left: "env(safe-area-inset-left, 0px)",
};
