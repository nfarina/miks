import { CSSProperties } from "react";
import { css } from "styled-components";
import { HostViewport } from "./types.js";

/**
 * Registers `--safe-area-bottom` as a length, which a custom property must be
 * for a transition to animate it (unregistered, it's a string, and jumps).
 * Then one transition where it's set moves everything padded by it. Once per
 * page; a value that isn't a length (none of crosswing's) would be 0px.
 */
export function registerSafeAreaBottom() {
  if (registered || typeof CSS === "undefined" || !("registerProperty" in CSS)) return;
  registered = true;
  try {
    CSS.registerProperty({ name: "--safe-area-bottom", syntax: "<length>", inherits: true, initialValue: "0px" });
  } catch {
    // Registered already, by the page's own CSS.
  }
}

let registered = false;

/**
 * Animates the bottom safe area as the keyboard comes and goes, with it: for a
 * page that runs behind the keyboard (HostProvider's `behindKeyboard`), whose
 * size then stays put, so only what it pads moves. iOS's keyboard curve,
 * approximately, over the keyboard's own duration when the host says.
 */
export const keyboardMotion = css`
  transition: --safe-area-bottom var(--keyboard-duration, 0.25s) cubic-bezier(0.38, 0.7, 0.125, 1);
`;

/**
 * The keyboard's duration for keyboardMotion, and, while it's up, the corner-
 * aware bottom inset (safeAreaCorners) following the safe area, since the
 * keyboard covers the screen's bottom corners.
 */
export function getKeyboardStyle(viewport: HostViewport): CSSProperties {
  return {
    ...(viewport.duration != null && { "--keyboard-duration": `${viewport.duration}s` }),
    ...(viewport.keyboardVisible && { "--safe-area-corner-bottom": "var(--safe-area-bottom)" }),
  } as CSSProperties;
}
