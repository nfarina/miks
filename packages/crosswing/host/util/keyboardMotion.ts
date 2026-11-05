import { CSSProperties } from "react";
import { css } from "styled-components";
import { SafeArea } from "../../safearea/safeArea.js";
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
  --safe-area-motion: --safe-area-bottom var(--keyboard-duration, 0.25s)
    cubic-bezier(0.38, 0.7, 0.125, 1);
  transition: var(--safe-area-motion);
`;

/**
 * keyboardMotion for an element below the HostProvider that publishes the
 * safe area again (CrosswingApp does), which would otherwise set the bottom
 * at once, its own value not being the one that's animating. Nothing unless
 * the HostProvider runs behind the keyboard.
 */
export const followKeyboardMotion = css`
  transition: var(--safe-area-motion, none);
`;

/**
 * The keyboard's duration for keyboardMotion, and, while it's up, the corner-
 * aware bottom inset (safeAreaCorners) following the safe area, since the
 * keyboard covers the screen's bottom corners. For a page behind the keyboard,
 * also the screen's own bottom inset, keyboard or not, as
 * `--safe-area-bottom-base`: what a floating tab bar sits on (see Tabs).
 */
export function getKeyboardStyle(viewport: HostViewport, screen?: SafeArea): CSSProperties {
  return {
    ...(viewport.duration != null && { "--keyboard-duration": `${viewport.duration}s` }),
    ...(screen && { "--safe-area-bottom-base": screen.bottom }),
    ...(viewport.keyboardVisible && { "--safe-area-corner-bottom": "var(--safe-area-bottom)" }),
  } as CSSProperties;
}
