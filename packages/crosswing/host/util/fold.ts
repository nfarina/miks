import { CSSProperties, use } from "react";
import { css, Interpolation } from "styled-components";
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
 * How far up from the bottom of what the keyboard leaves us to keep content,
 * so it isn't drawn into the fold. In the iPhone Duo's laptop pose the keyboard
 * fills the half on the table, so what's left of the view ends at the crease,
 * inside the band the system reserves for it, where nothing can be seen or
 * tapped. Zero when the keyboard is down, or ends anywhere else.
 */
export function getFoldAboveKeyboard(
  layout: HostLayout | undefined,
  viewport: HostViewport,
): number {
  if (!viewport.keyboardVisible || viewport.height == null) return 0;

  const division = layout?.divisions?.find(
    (region) => region.active && region.width > region.height,
  );
  if (!division) return 0;

  // The keyboard's top, relative to the band: a little slack below it, since
  // a sliver between the crease and the keys is no place for a text field.
  const overlap = viewport.height - division.y;
  return overlap > 0 && overlap <= division.height + 24 ? overlap : 0;
}
