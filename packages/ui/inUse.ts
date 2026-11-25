// Whether someone's at this window. Every window on a daemon sees the same
// sessions start and replies finish, and a tab's panel open or not is every
// window's (Tab.panel), so one left on another Mac, focused but with nobody
// there, opened panels for sessions run from here, by its own settings.

/** How long since the last key, click or scroll a window still counts as in use. */
const IN_USE_FOR = 30 * 60_000;

let lastInput = 0;

for (const event of ["keydown", "pointerdown", "wheel"] as const) {
  window.addEventListener(event, () => (lastInput = Date.now()), { capture: true, passive: true });
}

/** Focused, and used lately: the window to open panels by itself. */
export const windowInUse = () => document.hasFocus() && Date.now() - lastInput < IN_USE_FOR;
