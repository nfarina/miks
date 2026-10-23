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

    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);

  return focused;
}

function isWindowFocused(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
  );
}
