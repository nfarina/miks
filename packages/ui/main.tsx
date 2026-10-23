// First: in a browser, it gives `window.miks` before anything reads it.
import "./webBridge";
import { colors, getBuilderVarCSS } from "crosswing/colors";
import { CrosswingApp } from "crosswing/app";
import { CrosswingDesktopRootStyle } from "crosswing/containers";
import { fonts, GlobalFontFace } from "crosswing/fonts";
import { attachConsole } from "crosswing/host/console";
import { ModalRootProvider } from "crosswing/modals/context";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createGlobalStyle } from "styled-components";
import { App } from "./App";

const RootStyle = createGlobalStyle`
  body {
    ${getBuilderVarCSS([colors.textBackground])}
    background: ${colors.textBackground()};
  }
`;

// A native app's chrome: the system font, not crosswing's web fonts.
const systemUI: GlobalFontFace = {
  family: `ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif`,
  weight: "normal",
  style: "normal",
  fallback: "sans-serif",
};

const miksFonts = [
  fonts.display.override({ face: systemUI, weight: "400" }),
  fonts.displayMedium.override({ face: systemUI, weight: "500" }),
  fonts.displayBold.override({ face: systemUI, weight: "600" }),
];

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
    <CrosswingDesktopRootStyle />
    <RootStyle />
    <CrosswingApp faces={[systemUI]} fonts={miksFonts}>
      <ModalRootProvider allowDesktopPresentation>
        <App />
      </ModalRootProvider>
    </CrosswingApp>
  </StrictMode>,
);
