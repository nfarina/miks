import { CSSProperties, use } from "react";
import { css, Interpolation } from "styled-components";
import { SafeArea } from "../../safearea/safeArea.js";
import { HostContext } from "../context/HostContext.js";
import { HostLayout, HostViewport } from "./types.js";

/**
 * Where the fold runs down the screen when it's in play (the iPhone Duo in the
 * book pose), in screen coordinates, including the margins the system asks
 * interactive content to keep clear of it. Null when there's no fold, or it
 * doesn't apply (fully open, where it's inactive), or it doesn't divide us
 * (see getEdgeFold).
 */
export type Fold = { left: number; right: number };

export function getFold(layout: HostLayout | undefined): Fold | null {
  const fold = getActiveFold(layout);
  return fold && !isAtEdge(fold, layout!) ? fold : null;
}

/**
 * The part of a fold that only clips the edge of our window, like when we're
 * one side of Split View on an iPhone Duo in the book pose: then it's something
 * to keep clear of, as insets from each side, rather than a divide to lay out
 * around.
 */
export function getEdgeFold(
  layout: HostLayout | undefined,
): { left: number; right: number } | null {
  const fold = getActiveFold(layout);
  if (!fold || !isAtEdge(fold, layout!)) return null;

  return fold.left < layout!.width - fold.right
    ? { left: fold.right, right: 0 }
    : { left: 0, right: layout!.width - fold.left };
}

function getActiveFold(layout: HostLayout | undefined): Fold | null {
  const division = layout?.divisions?.find(
    (region) => region.active && region.height > region.width,
  );
  return division ? { left: division.x, right: division.x + division.width } : null;
}

/** Whether a fold leaves too little on one side to put anything there. */
function isAtEdge(fold: Fold, layout: HostLayout): boolean {
  return Math.min(fold.left, layout.width - fold.right) < layout.width / 4;
}

/** The fold from the host's layout, if it's in play. */
export function useFold(): Fold | null {
  return getFold(use(HostContext).layout);
}

/**
 * CSS custom properties for the fold, for a host provider: `--fold` is
 * "active" while there is one (see whenFolded), and `--fold-left` and
 * `--fold-right` are distances from the screen's left edge.
 */
export function getFoldStyle(layout: HostLayout | undefined): CSSProperties {
  const fold = getFold(layout);
  if (!fold) return {};

  return {
    "--fold": "active",
    "--fold-left": `${fold.left}px`,
    "--fold-right": `${fold.right}px`,
  } as CSSProperties;
}

/**
 * Styles for when a fold runs down the screen, for arranging content on either
 * side of it with `--fold-left` and `--fold-right`.
 */
export function whenFolded(styles: Interpolation<object>) {
  return css`
    @container style(--fold: active) {
      ${styles}
    }
  `;
}

/**
 * Where to end the page and how much of its bottom to keep clear when the
 * keyboard ends at a fold across the screen. In the iPhone Duo's laptop pose
 * the keyboard fills the half on the table, and its frame starts at the top of
 * the band the system reserves around the crease (measured: 455.5, the band's
 * top), but it draws only below the band, with rounded top corners, leaving
 * the band and those corners showing whatever's behind. So the page runs on to
 * the bottom of the window, behind the keyboard, for its own backgrounds to
 * fill all of that, with everything from the band down as bottom safe area,
 * keeping content above it. The same for a keyboard ending inside the band, or
 * a little below it, since a sliver between the crease and the keys is no
 * place for a text field. Null when the keyboard is down, or ends anywhere
 * else.
 */
export function getKeyboardFold(
  layout: HostLayout | undefined,
  viewport: HostViewport,
): { height: number; bottom: number } | null {
  if (!viewport.keyboardVisible || viewport.height == null) return null;

  const division = layout?.divisions?.find(
    (region) => region.active && region.width > region.height,
  );
  if (!division) return null;

  const top = viewport.height;
  const bandBottom = division.y + division.height;
  // A point of slack above, for rounding.
  if (top < division.y - 1 || top > bandBottom + 24) return null;

  const height = Math.max(top, layout!.height);
  return { height, bottom: height - division.y };
}

/**
 * Runs the page down behind the keyboard when it ends at a fold (see
 * getKeyboardFold), keeping content above the fold with the bottom safe area.
 * With `behindKeyboard`, behind any keyboard, keeping content above it: the
 * keyboard's rounded top corners (and a translucent one) then show the page's
 * own backgrounds rather than what's behind it. Only for a page sized by the
 * viewport's height that pads its bottom by the safe area.
 */
export function extendThroughFold(
  safeArea: SafeArea,
  layout: HostLayout | undefined,
  viewport: HostViewport,
  { behindKeyboard = false }: { behindKeyboard?: boolean } = {},
): { safeArea: SafeArea; viewport: HostViewport } {
  const fold =
    getKeyboardFold(layout, viewport) ??
    (behindKeyboard && viewport.keyboardVisible && viewport.height != null && layout
      ? { height: layout.height, bottom: Math.max(0, layout.height - viewport.height) }
      : null);
  if (!fold) return { safeArea, viewport };

  return {
    safeArea: { ...safeArea, bottom: `max(${safeArea.bottom}, ${fold.bottom}px)` },
    viewport: { ...viewport, height: fold.height },
  };
}
