import { CSSProperties } from "react";
import { SafeArea } from "../../safearea/safeArea.js";
import { getEdgeFold } from "./fold.js";
import { HostLayout } from "./types.js";

/**
 * The room past the strip that the system keeps on the iPhone Duo, where its
 * safe area (84px) is the strip's inset (26px) and width (44px) plus this.
 */
const BAR_STRIP_GAP = 14;

/**
 * Room to keep on each side beyond what the host's safe area says. The safe
 * area covers our bar strip when the system's own status strip shares its
 * edge, but not in Split View on the iPhone Duo, where the status strip is
 * with the other app and ours has only the bar edge to go on. A fold that just
 * clips our window's edge isn't in the safe area either.
 */
function getReserve(layout: HostLayout | undefined): { left: number; right: number } {
  const reserve = { left: 0, right: 0, ...getEdgeFold(layout) };

  const edge = layout?.barEdge;
  const bar = edge && layout.bars?.[edge];
  if (edge && bar) {
    const inset = edge === "right" ? layout.width - bar.x - bar.width : bar.x;
    reserve[edge] = Math.max(reserve[edge], inset + bar.width + BAR_STRIP_GAP);
  }

  return reserve;
}

/** The host's safe area, widened by getReserve. */
export function reserveSafeArea(safeArea: SafeArea, layout: HostLayout | undefined): SafeArea {
  const { left, right } = getReserve(layout);
  return {
    ...safeArea,
    ...(left > 0 && { left: `max(${safeArea.left}, ${left}px)` }),
    ...(right > 0 && { right: `max(${safeArea.right}, ${right}px)` }),
  };
}

/**
 * CSS custom properties locating the strip where the system puts a vertical
 * bar (clear of the camera and the rounded corners), for the BarStrip
 * component. Expressed as distances from the screen edges so they hold for
 * anything laid out against those edges.
 */
export function getBarStripStyle(layout: HostLayout | undefined): CSSProperties {
  const edge = layout?.barEdge;
  const bar = edge && layout.bars?.[edge];
  if (!edge || !bar) return {};

  return {
    "--bar-strip-width": `${bar.width}px`,
    "--bar-strip-edge-inset": `${edge === "right" ? layout.width - bar.x - bar.width : bar.x}px`,
    "--bar-strip-top": `${bar.y}px`,
    "--bar-strip-bottom": `${layout.height - bar.y - bar.height}px`,
  } as CSSProperties;
}

/**
 * CSS custom properties for a bar along the top, for safeAreaTopBar: its sides
 * where the system would put one, clear of the screen's rounded corners (the
 * iPhone Duo's inner display, whose corners are large, while the safe area
 * there says nothing of them). And its top too, where that's higher than the
 * safe area: beside the cameras and the status bar rather than under them, as
 * on the inner display upright, whose status sits in the top-right corner.
 * Nothing where the host reports no bars, where the properties fall back to
 * the safe area.
 */
export function getTopBarStyle(layout: HostLayout | undefined): CSSProperties {
  const bar = layout?.bars?.top;
  if (!bar) return {};

  // Never inside the safe area, as reserveSafeArea widens it (our own bar
  // strip, in Split View).
  const { safeArea } = layout;
  const reserve = getReserve(layout);
  const left = Math.max(bar.x, safeArea.left, reserve.left);
  const right = Math.max(layout.width - bar.x - bar.width, safeArea.right, reserve.right);

  return {
    ...(bar.y < safeArea.top && { "--safe-area-top-bar-top": `${bar.y}px` }),
    "--safe-area-top-bar-left": `${left}px`,
    "--safe-area-top-bar-right": `${right}px`,
  } as CSSProperties;
}

/**
 * CSS custom properties for the safe area plus the screen's rounded corners,
 * along each edge, for safeAreaCorners. The host reports two corner
 * adaptations (clearing the corners horizontally or vertically); we take the
 * larger along each edge.
 */
export function getSafeAreaCornersStyle(layout: HostLayout | undefined): CSSProperties {
  const corners = layout?.safeAreaCorners;
  if (!corners) return {};

  const { horizontal, vertical } = corners;
  const reserve = getReserve(layout);

  return {
    "--safe-area-corner-top": `${Math.max(horizontal.top, vertical.top)}px`,
    "--safe-area-corner-right": `${Math.max(horizontal.right, vertical.right, reserve.right)}px`,
    "--safe-area-corner-bottom": `${Math.max(horizontal.bottom, vertical.bottom)}px`,
    "--safe-area-corner-left": `${Math.max(horizontal.left, vertical.left, reserve.left)}px`,
  } as CSSProperties;
}
