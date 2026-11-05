import { ReactNode, use } from "react";
import { BarEdgeContext } from "../context/BarEdgeContext.js";
import { HostContext, defaultHostContext } from "../context/HostContext.js";
import { StyledHostProvider } from "../context/HostProvider.js";
import {
  getBarStripStyle,
  getSafeAreaCornersStyle,
  getTopBarStyle,
  reserveSafeArea,
} from "../util/barStrip.js";
import { getFoldStyle } from "../util/fold.js";
import { getPointerStyle } from "../util/pointer.js";
import { HostContextValue } from "../util/types.js";

/**
 * Useful for hosting Storybook stories that use Host from context.
 *
 * Pass `inherit` to start from the surrounding host instead of a blank mock,
 * keeping its container and features and overriding only what you give (like
 * a layout), for simulating devices around a live app.
 */
export function MockHostProvider({
  children,
  inherit,
  ...host
}: { children?: ReactNode; inherit?: boolean } & Partial<HostContextValue>) {
  const parent = use(HostContext);

  // A mock layout implies its safe area, unless you gave one explicitly.
  const safeArea =
    host.layout &&
    reserveSafeArea(
      {
        top: `${host.layout.safeArea.top}px`,
        right: `${host.layout.safeArea.right}px`,
        bottom: `${host.layout.safeArea.bottom}px`,
        left: `${host.layout.safeArea.left}px`,
      },
      host.layout,
    );

  const overrides = { ...(safeArea && { safeArea }), ...host };
  const value = inherit ? { ...parent, ...overrides } : defaultHostContext(overrides);

  return (
    <HostContext value={value}>
      <BarEdgeContext value={value.layout?.barEdge ?? null}>
        {/* We need an actual HTML element in the DOM to attach our CSS custom properties to. */}
        <StyledHostProvider
          $safeArea={value.safeArea}
          style={{
            ...getPointerStyle(value.pointer),
            ...getBarStripStyle(value.layout),
            ...getFoldStyle(value.layout),
            ...getSafeAreaCornersStyle(value.layout),
            // As HostProvider does, so a mock device places a top bar where the real one would.
            ...getTopBarStyle(value.layout),
          }}
          children={children}
        />
      </BarEdgeContext>
    </HostContext>
  );
}
