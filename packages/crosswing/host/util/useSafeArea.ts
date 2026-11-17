import { useEffect, useState } from "react";
import { BROWSER_SAFE_AREA, SafeArea } from "../../safearea/safeArea.js";
import { HostContainer, HostFeatures, HostViewport } from "./types.js";

// Returns the SafeArea for the current host, or undefined if not yet
// determined.
export function useSafeArea(
  container: HostContainer,
  features: HostFeatures | undefined,
  viewport: HostViewport,
  { behindKeyboard = false }: { behindKeyboard?: boolean } = {},
): SafeArea | undefined {
  const [customSafeArea, setCustomSafeArea] = useState<string | null>(null);

  useEffect(() => {
    if (window["onSafeAreaChange"]) {
      console.error(
        "Another listener for `window.onSafeAreaChange` was found! There can only be one listener globally. Ensure you are only using the useSafeArea() once in your app.",
      );
      return;
    }

    // Called by iOS-injected JS when the keyboard is presented.
    window["onSafeAreaChange"] = setCustomSafeArea;

    return () => {
      delete window["onSafeAreaChange"];
    };
  }, []);

  const keyboardVisible = !!viewport.keyboardVisible;

  if (!features) return;
  const { safeArea, pendingSafeArea } = features;

  if (customSafeArea) {
    return JSON.parse(customSafeArea);
  } else if (pendingSafeArea) {
    return JSON.parse(pendingSafeArea);
  } else if (container === "ios") {
    if (safeArea) {
      // This is a device running iOS 11, meaning the CSS implementation will
      // have defined the necessary constants.
      return {
        top: "env(safe-area-inset-top)",
        right: "env(safe-area-inset-right)",
        // When the keyboard is visible, the page ends at it, which leaves no
        // bottom inset. A page behind the keyboard keeps the screen's, which
        // what floats over the bottom stands on as the keyboard covers it
        // (see safeAreaResting); the keyboard's own inset is added to it (see
        // extendThroughFold).
        bottom:
          keyboardVisible && !behindKeyboard ? "0px" : "env(safe-area-inset-bottom)",
        left: "env(safe-area-inset-left)",
      };
    } else {
      // Legacy - fall back to manually accounting for the long-standard 20px
      // status bar on iOS devices.
      return {
        top: "20px",
        right: "0px",
        bottom: "0px",
        left: "0px",
      };
    }
  } else if (container === "android") {
    // Android web views don't have safe areas.
    return {
      top: "0px",
      right: "0px",
      bottom: "0px",
      left: "0px",
    };
  } else {
    // We're on the web, use the CSS environment variables provided by the
    // browser you're using.
    return BROWSER_SAFE_AREA;
  }
}
