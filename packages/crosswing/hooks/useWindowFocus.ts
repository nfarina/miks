import { useEffect, useState } from "react";

/**
 * Whether the page has the user's attention: it isn't hidden, and its window
 * is the focused one. A page can be fully drawn on screen without it - a Mac
 * app or browser window sitting behind the one in front.
 */
export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(isWindowFocused);

  useEffect(() => {
    const update = () => setFocused(isWindowFocused());

    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    update();

    // Asked again every second too, since focus can change without any of
    // those firing: a web view inside a native app becomes (or stops being)
    // the thing with focus by native means the page never hears about.
    // Without this, whatever waits on focus waits for the next event, which
    // may be the user leaving and coming back.
    const interval = setInterval(update, 1000);

    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return focused;
}

function isWindowFocused(): boolean {
  if (typeof document === "undefined" || document.visibilityState !== "visible") return false;

  // On a phone or tablet a visible page is the one in front; there is no
  // window to sit behind. And a web view there can report no focus while
  // being looked at, until something in it is touched.
  if (window.matchMedia?.("(hover: none) and (pointer: coarse)").matches) return true;

  return document.hasFocus();
}
