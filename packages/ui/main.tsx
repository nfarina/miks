// First: in a browser, it gives `window.miks` before anything reads it.
import "./webBridge";
import { colors, getBuilderVarCSS } from "crosswing/colors";
import { CrosswingApp } from "crosswing/app";
import { CrosswingDesktopRootStyle } from "crosswing/containers";
import { attachConsole } from "crosswing/host/console";
import { HostProvider } from "crosswing/host/context";
import { ModalRootProvider } from "crosswing/modals/context";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createGlobalStyle } from "styled-components";
import { App } from "./App";
import { miksFonts, systemUI } from "./fonts";
import { ErrorBoundary } from "./ErrorBoundary";

const RootStyle = createGlobalStyle`
  /* No text autosizing: on an iPhone, turning to landscape and back left
     the chat's replies (long runs of text) huge, and the rest as it was. */
  html {
    -webkit-text-size-adjust: 100%;
    text-size-adjust: 100%;
  }

  body {
    ${getBuilderVarCSS([colors.textBackground])}
    background: ${colors.textBackground()};
  }
`;

// In the iOS app, the page's console goes to the app's log (where
// `devicectl device process launch --console` shows it), errors included.
attachConsole();
window.addEventListener("error", (event) => console.error(event.message, event.filename, event.lineno));
window.addEventListener("unhandledrejection", (event) => console.error(String(event.reason)));

// A file dropped anywhere but a terminal would otherwise open in the window.
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => event.preventDefault());

const root = createRoot(document.getElementById("root")!);
root.render(
  <StrictMode>
    <ErrorBoundary>
      <CrosswingDesktopRootStyle />
      <RootStyle />
      <CrosswingApp faces={[systemUI]} fonts={miksFonts}>
        {/* The screen's safe area (the status bar, the iPhone Duo's strip and
            fold) as --safe-area-* properties, in the iOS app and a browser. */}
        <HostProvider>
          <ModalRootProvider allowDesktopPresentation>
            <App />
          </ModalRootProvider>
        </HostProvider>
      </CrosswingApp>
    </ErrorBoundary>
  </StrictMode>,
);
