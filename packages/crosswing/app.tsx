import { createContext, HTMLAttributes, use } from "react";
import { styled } from "styled-components";
import { getBuilderVarCSS } from "./colors/builders.js";
import { ColorBuilder, colors, shadows } from "./colors/colors.js";
import {
  CrosswingFontFaceStyle,
  faces,
  FontBuilder,
  fonts,
  getFontVarCSS,
  GlobalFontFace,
} from "./fonts/fonts.js";
import { HostContext, hasHostProvider } from "./host/context/HostContext.js";
import { followKeyboardMotion } from "./host/util/keyboardMotion.js";
import { BROWSER_SAFE_AREA, getSafeAreaCSS, SafeArea } from "./safearea/safeArea.js";

/**
 * The colors, fonts, and font faces the app is actually rendered with — our
 * defaults plus whatever the project overrode. Anything that has to restate our
 * styling somewhere it can't be inherited (a preview document written into an
 * iframe, say) should build it from this rather than from the raw defaults,
 * which is how you end up with Fira Sans in a project that uses system fonts.
 */
export type CrosswingAppStyle = {
  colors: ColorBuilder[];
  faces: GlobalFontFace[];
  fonts: FontBuilder[];
};

export const CrosswingAppStyleContext = createContext<CrosswingAppStyle>({
  colors: [...Object.values(colors), ...Object.values(shadows)],
  faces: Object.values(faces),
  fonts: Object.values(fonts),
});

export function CrosswingApp({
  colors: overriddenColors = [],
  faces: overriddenFaces = [],
  fonts: overriddenFonts = [],
  safeArea: overriddenSafeArea,
  children,
  transparent,
  ...rest
}: {
  colors?: ColorBuilder[];
  faces?: GlobalFontFace[];
  fonts?: FontBuilder[];
  safeArea?: SafeArea;
  transparent?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const resolvedColors = [...Object.values(colors), ...Object.values(shadows), ...overriddenColors];

  // We publish the safe area again here, which hides whatever an enclosing
  // host provider published, so restate the host's: it knows about more than
  // CSS does (the keyboard covering the bottom inset, our bar strip in Split
  // View on the iPhone Duo). Without a host, it's whatever the browser says.
  const host = use(HostContext);
  const safeArea =
    overriddenSafeArea ?? (hasHostProvider(host) ? host.safeArea : BROWSER_SAFE_AREA);

  const resolvedFaces = [...Object.values(faces), ...overriddenFaces];
  const resolvedFonts = [...Object.values(fonts), ...overriddenFonts];

  return (
    <CrosswingAppStyleContext
      value={{ colors: resolvedColors, faces: resolvedFaces, fonts: resolvedFonts }}
    >
      <StyledCrosswingApp
        $colors={resolvedColors}
        $fonts={resolvedFonts}
        $safeArea={safeArea}
        data-transparent={!!transparent}
        {...rest}
      >
        <CrosswingFontFaceStyle faces={resolvedFaces} />
        {children}
      </StyledCrosswingApp>
    </CrosswingAppStyleContext>
  );
}

export const StyledCrosswingApp = styled.div<{
  $colors: ColorBuilder[];
  $fonts: FontBuilder[];
  $safeArea: SafeArea;
}>`
  /* I try hard to avoid props in styled-components but this is the only
     practical way to embed CSS at the element level. */
  ${(p) => getBuilderVarCSS(p.$colors)}
  ${(p) => getFontVarCSS(p.$fonts)}
  ${(p) => getSafeAreaCSS(p.$safeArea)}
  /* Moving with the keyboard, as the host's does (see keyboardMotion). */
  ${followKeyboardMotion}

  &[data-transparent="false"] {
    background: ${colors.textBackground()};
  }

  color: ${colors.text()};
  font: ${fonts.display({ size: 14 })};
  display: flex;
  flex-flow: column;

  > * {
    flex-grow: 1;
  }
`;
