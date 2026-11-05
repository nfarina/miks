import { fonts, GlobalFontFace } from "crosswing/fonts";

/** A native app's chrome: the system font, not crosswing's web fonts. */
export const systemUI: GlobalFontFace = {
  family: `ui-sans-serif, -apple-system, system-ui, "Segoe UI", Helvetica, Arial, sans-serif`,
  weight: "normal",
  style: "normal",
  fallback: "sans-serif",
};

export const miksFonts = [
  fonts.display.override({ face: systemUI, weight: "400" }),
  fonts.displayMedium.override({ face: systemUI, weight: "500" }),
  fonts.displayBold.override({ face: systemUI, weight: "600" }),
];
