import { CSSProperties, HTMLAttributes } from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { HostLayout, HostPlatform, HostRect } from "../util/types.js";
import { viewportContainer } from "../../viewport/viewport.js";
import { MockHostProvider } from "./MockHostProvider.js";

/**
 * For Storybook; renders children in a frame the size of a mock host layout,
 * with a MockHostProvider reporting that layout (and its safe area). Host
 * coordinates are relative to our window, so things like HostLayoutDebug line
 * up with it. When the window is only part of the screen (Split View), the
 * rest of the screen stands in for the other app.
 *
 * Pass `live` to keep the surrounding (real) host and only report the layout,
 * for running a live app on the mock device.
 */
export function MockDevice({
  layout,
  live,
  cutouts = getCameraCutouts(layout),
  platform,
  children,
  style,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  layout: HostLayout;
  live?: boolean;
  /** Camera cutouts to draw over the screen. Defaults to the cameras the layout reports. */
  cutouts?: HostRect[];
  /** The platform the host reports, like "macOS" for the Mac app. */
  platform?: HostPlatform;
}) {
  // Mock devices are touch devices, even in a desktop browser (but see pointer).
  // Partly folded (the iPhone Duo's book and laptop poses), we shade the screen
  // toward the crease, deeper the more it's folded. We can't really bend it:
  // that would mean drawing the app twice, once per half.
  // The crease is past the division's leading margin, which holds even when
  // Split View cuts the division off at the edge of our window.
  const division = layout.divisions?.[0];
  const across = !!division && division.width > division.height; // Laptop.
  const hinge = layout.hinge?.status === "partiallyOpen" ? layout.hinge : null;
  const appWindow = layout.window ?? { x: 0, y: 0, width: layout.width, height: layout.height };
  const screen = layout.screen ?? layout;
  const foldStyle =
    division && hinge
      ? ({
          "--fold-center": across
            ? `${appWindow.y + division.y + division.margins.top}px`
            : `${appWindow.x + division.x + division.margins.left}px`,
          "--fold-depth": Math.max(0, Math.min(1, (180 - hinge.angle) / 90)),
        } as CSSProperties)
      : null;

  // A Mac is pointed at with a mouse or trackpad.
  const pointer = platform === "macOS" ? ("fine" as const) : ("coarse" as const);
  const host = live
    ? { inherit: true, pointer, ...(platform && { platform }) }
    : { container: "ios" as const, pointer, ...(platform && { platform }) };

  return (
    <MockHostProvider {...host} layout={layout}>
      <StyledMockDevice style={{ width: screen.width, height: screen.height, ...style }} {...rest}>
        <div
          className="window"
          style={{
            left: appWindow.x,
            top: appWindow.y,
            width: layout.width,
            height: layout.height,
          }}
        >
          {children}
          {cutouts.map((rect, i) => (
            <div
              key={i}
              className="cutout"
              style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            />
          ))}
        </div>
        {foldStyle && <div className="fold-shading" data-across={across} style={foldStyle} />}
      </StyledMockDevice>
    </MockHostProvider>
  );
}

/**
 * The cameras among the layout's reserved regions: small occlusions that are in
 * use, as opposed to larger ones like the iPhone Duo's status area.
 */
function getCameraCutouts(layout: HostLayout): HostRect[] {
  return (layout.occlusions ?? []).filter(
    (region) => region.active && Math.max(region.width, region.height) <= 60,
  );
}

export const StyledMockDevice = styled.div`
  /* Doubled up to outrank the provider's rule that stretches its children. */
  && {
    flex: none;
    align-self: center;
  }

  position: relative;
  border-radius: 40px;
  /* The other app, in Split View. */
  background: ${colors.textBackgroundAlt()};
  overflow: hidden;
  box-shadow: 0 0 0 8px ${colors.extraExtraDarkGray()};

  > .window {
    position: absolute;
    display: flex;
    flex-flow: column;
    background: ${colors.textBackground()};
    /* Width-dependent styles inside respond to the device, not the browser. */
    ${viewportContainer}
    overflow: hidden;
    /* So is a fixed element, like an app's root, which fills the device. */
    contain: layout;

    > *:not(.cutout) {
      flex-grow: 1;
    }
  }

  > .fold-shading {
    position: absolute;
    inset: 0;
    z-index: 999;
    pointer-events: none;
    --shade: rgba(0, 0, 0, calc(0.22 * var(--fold-depth)));
    --glint: rgba(255, 255, 255, calc(0.4 * var(--fold-depth)));

    --direction: to right;

    &[data-across="true"] {
      --direction: to bottom;
    }

    /* Each half darkens toward the crease as it turns away from us, with a
       thin glint along the hinge itself. */
    background:
      linear-gradient(
        var(--direction),
        transparent calc(var(--fold-center) - 1.5px),
        var(--glint) var(--fold-center),
        transparent calc(var(--fold-center) + 1.5px)
      ),
      linear-gradient(
        var(--direction),
        transparent calc(var(--fold-center) - 50px),
        var(--shade) var(--fold-center),
        transparent calc(var(--fold-center) + 50px)
      );
  }

  > .window > .cutout {
    position: absolute;
    z-index: 1000;
    background: black;
    border-radius: 999px;
    pointer-events: none;
  }
`;
