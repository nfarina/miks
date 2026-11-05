import { ArrowLeft } from "lucide-react";
import { HTMLAttributes, ReactNode, RefObject, use, useEffect, useRef, useState } from "react";
import { css, styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import {
  BarStrip,
  BarStripGroup,
  StyledBarStrip,
  barStripPill,
} from "../../components/BarStrip.js";
import { fonts } from "../../fonts/fonts.js";
import { BarEdgeContext } from "../../host/context/BarEdgeContext.js";
import { HostContext } from "../../host/context/HostContext.js";
import { useHostStatusBar } from "../../host/features/HostStatusBar.js";
import { StatusBarStyleAttribute } from "../../host/util/useAutoStatusBar.js";
import { provideSafeArea, safeArea, safeAreaCorners } from "../../safearea/safeArea.js";
import { RouterContext } from "../context/RouterContext.js";
import { TabsContext } from "../tabs/TabsContext.js";
import {
  NavAccessory,
  NavAccessoryView,
  StyledNavAccessoryView,
  hasIcon,
} from "./NavAccessoryView.js";
import { NavTitleView, StyledNavTitleView } from "./NavTitleView.js";
import { scrollEdgeEffect } from "./scrollEdge.js";

/**
 * One accessory, or several. Where bars run vertically (iPhone Duo), each icon
 * accessory floats in its own circle; nest some in an array to share a pill,
 * like `[[up, down], share]`. Elsewhere the nesting is ignored.
 */
export type NavAccessories = NavAccessory | (NavAccessory | NavAccessory[])[];

export interface NavProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  /** One accessory, or several rendered side-by-side in the same slot. */
  left?: NavAccessories | null;
  /** One accessory, or several rendered side-by-side in the same slot. */
  right?: NavAccessories | null;
  /** Custom "back" accessory, only rendered when the back arrow would otherwise be rendered. */
  back?: Omit<NavAccessory, "to" | "back"> | null;
  disabled?: boolean;
  /** If provided, the back button will always go to this path instead of cycling back through history. */
  backTo?: string | null;
  /** Pass true to hide the hairline shadow under the nav bar. */
  hideSeparator?: boolean;
  /**
   * With `extendsUnderBars`, pass true when the page pins something right
   * under the header (a search field, say) that continues the bar: the
   * header's blur then ends at its bottom edge, and the pinned thing should
   * carry the fade below itself with `scrollEdgeEffect()`.
   */
  hideHeaderFade?: boolean;
  /** Pass true to hide the auto-generated back button (if displayed). */
  hideBackButton?: boolean;
  /** Pass true to hide the tab bar, if presented inside <Tabs>. */
  hideTabBar?: boolean;
  /** Pass true to render a transparent header. */
  transparentHeader?: boolean;
  /** Pass true to render a transparent background. */
  transparent?: boolean;
  /** Pass true to lay out any children below the nav bar area. */
  fullBleed?: boolean;
  /** Pass true to render a subtle dark gradient under the status bar area to increase text readability. Only rendered when `fullBleed` is true and on a supported platform. */
  darkenUnderStatusBar?: boolean;
  /** Pass true to indicate that, on mobile devices where content could sit underneath the system status bar, that the system status bar text should be white. */
  lightStatusBar?: boolean;
  /**
   * Pass true to let the content run under the nav header and any floating tab
   * bar, like iOS pages since iOS 26: the header's buttons float over the
   * content, with a soft blur behind them where it scrolls under. The content
   * gets the bars' space as its top and bottom safe area, so pad a scroller's
   * content with padSafeArea("top", "bottom") to start and end clear of them.
   */
  extendsUnderBars?: boolean;
  /** Pass true to hide the nav bar entirely. */
  hidden?: boolean;
  /** Marks this NavLayout as not having a way to go "back". Essential for good behavior on Android.  */
  isApplicationRoot?: boolean;
  /** Pass true to make the nav content area determine the height of the layout. */
  fitContent?: boolean;
}

export function NavLayout({
  title,
  subtitle,
  children,
  left,
  right,
  back: customBackAccessory,
  disabled,
  hideSeparator,
  hideHeaderFade,
  hideBackButton,
  hideTabBar,
  backTo,
  transparentHeader,
  transparent,
  fullBleed,
  extendsUnderBars,
  darkenUnderStatusBar,
  lightStatusBar,
  hidden,
  isApplicationRoot,
  fitContent,
  ...rest
}: NavProps & Omit<HTMLAttributes<HTMLDivElement>, "title">) {
  // Pull our back link (if any) from context.
  const { back, besideRoot, flags } = use(RouterContext);

  // Use the provided backTo path if any, otherwise fall back to the normal
  // back behavior.
  const resolvedBack = backTo ?? back;

  // Pull host info for safe area.
  const { container, platform, viewport, layout } = use(HostContext);
  // A regular-width screen, as the host says (not in a browser, which keeps
  // its centered titles).
  const regularWidth = layout?.sizeClass.horizontal === "regular";
  const statusBar = useHostStatusBar();

  const tabs = use(TabsContext);

  // Where the system runs bars vertically (the iPhone Duo's outer display, or
  // its inner display in landscape), icon controls move to a strip along that
  // edge: Back first, then the rest. Titles and text buttons stay up top.
  const barEdge = use(BarEdgeContext);
  const vertical = !!barEdge && !hidden;

  // An application root has no "up" — even if there's a location behind us in
  // the stack (e.g. we were reached via a <Redirect> from an index route),
  // honor the isApplicationRoot contract and never show a back button.
  const showsBack = !!(back || backTo) && !hideBackButton && !isApplicationRoot && !besideRoot;

  const backAccessory: NavAccessory = customBackAccessory
    ? { ...customBackAccessory, to: resolvedBack, back: true }
    : { icon: <ArrowLeft />, to: resolvedBack, back: true };

  // Keep the content clear of a floating tab bar, unless it runs under it (or
  // the bar is hidden for this page).
  const underTabBar = tabs.floatingTabBar && !hideTabBar;

  // While the keyboard's up for something inside us, a checkmark for
  // dismissing it takes the place of our right-hand controls (in the strip
  // too, when the bars run vertically).
  const layoutRef = useRef<HTMLDivElement>(null);
  const holdsKeyboard = useHoldsFocus(layoutRef, container === "ios" && !!viewport.keyboardVisible);
  const rightAccessories: NavAccessories | null | undefined = holdsKeyboard
    ? { title: "Done", role: "confirm", prominent: false, onClick: blurFocused }
    : right;

  // Icon controls that move to the strip when bars run vertically. Arrays are
  // groups that share a pill.
  const stripAccessories: (NavAccessory | NavAccessory[])[] = vertical
    ? [
        ...(showsBack && backAccessory.icon ? [backAccessory] : []),
        ...iconEntries(left),
        ...iconEntries(rightAccessories),
      ]
    : [];

  function getLeftAccessory() {
    if (vertical) {
      return renderSlot(
        [
          ...(showsBack && !backAccessory.icon ? [backAccessory] : []),
          ...toArray(left).filter((one) => !hasIcon(one)),
        ],
        "left",
      );
    }

    if (left) return renderSlot(toArray(left), "left");

    if (showsBack) return renderSlot([backAccessory], "left");

    // An empty slot still takes up its space, keeping the title centered.
    return renderSlot([], "left");
  }

  function getRightAccessory() {
    return renderSlot(
      vertical
        ? toArray(rightAccessories).filter((one) => !hasIcon(one))
        : toArray(rightAccessories),
      "right",
    );
  }

  if (
    !isApplicationRoot &&
    !hasBackAccessory(left) &&
    !back &&
    !hasBackAccessory(right) &&
    !flags?.isMock &&
    flags?.isMobileApp
  ) {
    console.warn(
      "Rendering a <NavLayout> without isApplicationRoot=true or any accessories marked as back=true. This will not be a good experience on Android!",
    );
  }

  return (
    <StyledNavLayout
      ref={layoutRef}
      data-nav-layout
      data-transparent={!!transparent}
      data-full-bleed={!!fullBleed}
      data-extends-under-bars={!!extendsUnderBars}
      data-floating-tab-bar={underTabBar}
      // A full-bleed page's content reaches the very top of the layout, so
      // advertise that intent: an app shell (e.g. TaskBannerLayout) can detect
      // this and let the content extend up under the status bar/safe area
      // rather than reserving that region globally.
      data-extend-under-status-bar={!!fullBleed || !!extendsUnderBars}
      data-disabled={!!disabled}
      data-hidden={!!hidden}
      data-hide-tab-bar={!!hideTabBar}
      data-fit-content={!!fitContent}
      data-regular-width={regularWidth}
      {...StatusBarStyleAttribute(lightStatusBar ? "light" : "default")} // Picked up on by useAutoStatusBar.
      {...rest}
    >
      <StyledNavHeader
        data-nav-header
        data-window-drag
        data-container={container}
        data-platform={platform}
        data-regular-width={regularWidth}
        data-hide-separator={!!hideSeparator}
        data-hide-fade={!!hideHeaderFade}
        data-transparent-header={!!transparentHeader}
      >
        {getLeftAccessory()}
        <NavTitleView title={title} subtitle={subtitle} className="center" />
        {getRightAccessory()}
      </StyledNavHeader>
      {children}
      {extendsUnderBars && underTabBar && <div className="bottom-edge" />}
      {fullBleed && darkenUnderStatusBar && statusBar && <div className="top-fade" />}
      {vertical && stripAccessories.length > 0 && (
        <BarStrip edge={barEdge}>
          {stripAccessories.map((entry, i) =>
            Array.isArray(entry) ? (
              <BarStripGroup key={i}>
                {entry.map((one, j) => (
                  <NavAccessoryView key={j} accessory={one} />
                ))}
              </BarStripGroup>
            ) : (
              <NavAccessoryView key={i} accessory={entry} />
            ),
          )}
        </BarStrip>
      )}
    </StyledNavLayout>
  );
}

/**
 * Renders a slot's accessory (or accessories). A single accessory renders as
 * the slot itself, exactly as it always has; several are wrapped in a row so
 * the header's slot layout (and anything targeting it) stays the same shape.
 */
/** Every accessory, with any groups flattened. */
function toArray(accessory: NavAccessories | null | undefined): NavAccessory[] {
  if (!accessory) return [];
  return Array.isArray(accessory) ? accessory.flat() : [accessory];
}

/** The icon accessories (and groups of them), for the bar strip. */
function iconEntries(
  accessory: NavAccessories | null | undefined,
): (NavAccessory | NavAccessory[])[] {
  if (!accessory) return [];
  const entries = Array.isArray(accessory) ? accessory : [accessory];

  return entries
    .map((entry) => (Array.isArray(entry) ? entry.filter(hasIcon) : entry))
    .filter((entry) => (Array.isArray(entry) ? entry.length > 0 : hasIcon(entry)));
}

/**
 * One of the header's side slots. Always rendered, even when empty, so the
 * slots stay equal and the title stays centered.
 */
function renderSlot(accessories: NavAccessory[], align: "left" | "right") {
  return (
    <div className="accessories" data-align={align}>
      {accessories.map((one, i) => (
        <NavAccessoryView key={i} accessory={one} />
      ))}
    </div>
  );
}

/**
 * Whether, while `active`, the focused element is ours: inside the given
 * NavLayout and not a NavLayout nested within it.
 */
function useHoldsFocus(ref: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [holds, setHolds] = useState(false);

  useEffect(() => {
    if (!active) {
      setHolds(false);
      return;
    }

    function check() {
      const focused = document.activeElement;
      setHolds(!!focused && focused.closest("[data-nav-layout]") === ref.current);
    }

    check();
    document.addEventListener("focusin", check);
    return () => document.removeEventListener("focusin", check);
  }, [active]);

  return holds;
}

/** Dismisses the keyboard, by taking focus from whatever raised it. */
function blurFocused() {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function hasBackAccessory(accessory: NavAccessories | null | undefined): boolean {
  return toArray(accessory).some((one) => one.back);
}

/**
 * Where the header's buttons start: below the status bar and clear of the
 * screen's corners, and never flush against the top where nothing's up there
 * (a browser window, or iPhone landscape). Where the system puts a top bar
 * higher than that (beside the camera island on the iPhone Duo's inner
 * display), the header goes there instead, like Safari's.
 */
const headerTop = `max(var(--safe-area-top-bar-top, ${safeAreaCorners.top()}), 10px)`;

/** The header's sides, kept clear of whatever shares its strip (the island). */
const headerLeft = `var(--safe-area-top-bar-left, ${safeArea.left()})`;
const headerRight = `var(--safe-area-top-bar-right, ${safeArea.right()})`;

export const StyledNavHeader = styled.div`
  display: flex;
  flex-flow: row;
  box-sizing: border-box;
  /* Like iOS's bars, built around 44px buttons with a little room below. */
  height: calc(54px + ${headerTop});
  padding-bottom: 10px;
  border-bottom: 1px solid ${colors.separator()};
  padding-top: ${headerTop};
  padding-left: ${headerLeft};
  padding-right: ${headerRight};

  /* With room to spare, the title centers on the screen (and so on any fold,
     like Safari's address on the iPhone Duo) rather than between the edges of
     the safe area, which a strip down one side would pull off center. */
  @container viewport (min-width: 700px) {
    padding-left: max(${safeArea.left()}, ${safeArea.right()});
    padding-right: max(${safeArea.left()}, ${safeArea.right()});
  }

  /* On a regular-width screen, with room across the page itself, the title
     leads, right after the left-hand controls, as iPadOS's do (and ours on
     the Mac, below). Not in a narrower page there, like a split view's pane
     or a floating sheet, which stay centered, as iPadOS's do. Nothing to
     center, so the sides keep clear of only what's on their own side. */
  @container nav-layout (min-width: 600px) {
    &[data-regular-width="true"] {
      padding-left: ${headerLeft};
      padding-right: ${headerRight};

      > .accessories {
        width: auto;

        /* Nothing to hold apart from the title, so less of a gap before it. */
        &[data-align="left"]:empty {
          padding-left: 10px;
        }
      }

      > ${StyledNavTitleView} {
        > .title,
        > .subtitle {
          text-align: left;
        }
      }
    }
  }

  /* A Mac window's traffic lights sit in our top-left corner, which the host
     reports as a corner inset. Only there: an iPhone reports corner insets
     too, for bars running into its rounded corners, which ours (below the
     status bar) doesn't. Nothing's in the right corner, so no mirroring it
     there to center the title; this outranks the rule above at any width.

     The lights would pull a centered title off center, so the title leads
     instead, right after the left-hand controls, like a Mac toolbar's. Every
     header there does (not just the one beside the lights) so they match. */
  &[data-platform="macOS"] {
    padding-left: ${safeAreaCorners.left()};
    padding-right: ${safeArea.right()};

    /* The side slots no longer need to match, so they fit their controls. */
    > .accessories {
      width: auto;

      /* Nothing to hold apart from the title, so less of a gap before it. */
      &[data-align="left"]:empty {
        padding-left: 10px;
      }
    }

    > ${StyledNavTitleView} {
      > .title,
      > .subtitle {
        text-align: left;
      }

      /* A Mac window's title is smaller than an iOS bar's. */
      > .title {
        font: ${fonts.displayBold({ size: 15, line: "1.2" })};
      }

      > .subtitle {
        font: ${fonts.display({ size: 11, line: "1.2" })};
      }
    }
  }

  transition:
    background-color 0.2s ease-in-out,
    border-bottom-color 0.2s ease-in-out;
  background-color: transparent;
  position: relative;

  &[data-transparent-header="false"] {
    background-color: ${colors.textBackground()};
  }

  /* When the header is transparent, we want to prevent the user from clicking on the title container, but allow them to click on the left and right accessories (or any title content itself). */
  &[data-transparent-header="true"] {
    pointer-events: none;

    > *:not(${StyledNavTitleView}) {
      pointer-events: auto;
    }
  }

  &[data-hide-separator="true"] {
    /* We don't hide the border completely because it shifts the content. There are many places where we hide the border until you scroll the content for instance. */
    border-bottom: 1px solid transparent;

    &[data-transparent-header="false"] {
      border-bottom: 1px solid ${colors.textBackground()};
    }
  }

  /* Wide enough for two buttons, so both sides match and the title stays
     centered. */
  > *:nth-child(1) {
    flex-shrink: 0;
    width: 112px;
  }

  > *:nth-child(2) {
    margin: 0 10px;
    flex-shrink: 0;
    flex-grow: 1;
    width: 0;
  }

  > *:nth-child(3) {
    flex-shrink: 0;
    width: 112px;
  }

  /* A side slot, holding any number of accessories. */
  > .accessories {
    display: flex;
    flex-flow: row;
    align-items: center;
    box-sizing: border-box;
    gap: 8px;

    &[data-align="left"] {
      justify-content: flex-start;
      padding-left: 16px;
    }

    &[data-align="right"] {
      justify-content: flex-end;
      padding-right: 16px;
    }

    /* Floating buttons like iOS's bar buttons (and our bar strip): icons in
       circles, text in capsules. */
    > ${StyledNavAccessoryView} {
      ${barStripPill}
      flex-shrink: 0;
      box-sizing: border-box;
      /* A touch under iOS's 44px, so the edge and shadow aren't clipped at
         the top of the stack we're in. */
      height: 40px;
      padding: 0 16px;
      justify-content: center;
      border: none;
      color: ${colors.text()};
      cursor: pointer;

      &[data-icon="true"] {
        width: 40px;
        padding: 0;
      }

      > svg {
        width: 20px;
        height: 20px;
      }

      &[data-destructive="true"] {
        color: ${colors.red()};
      }

      &[data-prominent="true"] {
        background: ${colors.primary()};
        color: ${colors.white()};
      }

      &[data-plain="true"] {
        background: none;
        box-shadow: none;
        backdrop-filter: none;
        -webkit-backdrop-filter: none;
        padding: 0;
        cursor: default;
      }
    }
  }
`;

export const StyledNavLayout = styled.div`
  display: flex;
  flex-flow: column;

  /* For the header to measure the page by (see StyledNavHeader). Not a page
     sized by its content, which a container can't be. */
  &[data-regular-width="true"]:not([data-fit-content="true"]) {
    container: nav-layout / inline-size;
  }

  /* The space the bars take along the top and bottom, for content that runs
     under them. Captured here since the content redefines the safe area in
     terms of them. */
  --nav-header-height: calc(54px + ${headerTop});
  --nav-tab-bar-height: var(--floating-tab-bar-height, 0px);

  &[data-transparent="false"] {
    background: ${colors.textBackground()};
  }

  /* Create new stacking context so our children's z-index will work.
     we can't "position: relative" because if we're presented in a
     <NavStack> (which we probably are) then it will assign us a
     "position: absolute". */
  isolation: isolate;

  > ${StyledNavHeader} {
    flex-shrink: 0;
    z-index: 1;
  }

  &[data-full-bleed="true"] {
    > ${StyledNavHeader} {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
    }
  }

  &[data-hidden="true"] {
    > ${StyledNavHeader} {
      display: none;
    }
  }

  /* Content that runs under the bars gets their space as its safe area. */
  &[data-extends-under-bars="true"] {
    > ${StyledNavHeader} {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      background: none;
      border-bottom-color: transparent;

      /* A soft blur where content scrolls under the buttons and title, fading
         out across the header's bottom edge rather than ending at a hard line
         (iOS's "scroll edge effect"). Only half the fade hangs below, so it
         doesn't wash out the top of whatever the page starts with. */
      &::before {
        ${scrollEdgeEffect()}
        inset: 0 0 -12px 0;
        transition: opacity 0.2s ease-in-out;
      }

      /* The page pins something of its own right under the header (a search
         field, say), which carries the fade instead. */
      &[data-hide-fade="true"]::before {
        ${scrollEdgeEffect({ fade: false })}
        /* Over the header's (transparent) bottom border too, or it leaves a
           1px gap above whatever's pinned below. */
        inset: 0 0 -1px 0;
      }

      &[data-transparent-header="true"]::before {
        opacity: 0;
      }
    }

    &:not([data-hidden="true"]) > *:nth-child(2):not(${StyledBarStrip}) {
      ${provideSafeArea({ top: "var(--nav-header-height)" })}
    }

    &[data-floating-tab-bar="true"] > *:nth-child(2):not(${StyledBarStrip}) {
      ${provideSafeArea({ bottom: "var(--nav-tab-bar-height)" })}
    }

    /* The same effect, fainter, behind a floating tab bar. */
    > .bottom-edge {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      height: var(--nav-tab-bar-height);
      pointer-events: none;
      background: linear-gradient(
        ${colors.textBackground({ alpha: 0 })},
        ${colors.textBackground({ alpha: 0.6 })}
      );
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
      mask-image: linear-gradient(transparent, black 60%);
      -webkit-mask-image: linear-gradient(transparent, black 60%);
    }
  }

  /* Other content stays clear of a floating tab bar, and the bar covers the
     bottom edge so it doesn't need to. */
  &[data-extends-under-bars="false"][data-floating-tab-bar="true"]
  > *:nth-child(2):not(${StyledBarStrip}) {
    margin-bottom: var(--nav-tab-bar-height);
    ${provideSafeArea({ bottom: "0px" })}
  }

  /* Any layouts nested in our content are clear of the tab bar already. */
  &[data-floating-tab-bar="true"] > *:nth-child(2):not(${StyledBarStrip}) {
    --floating-tab-bar-height: 0px;
  }

  /* The header has the top inset covered, either by sitting below it or by
     sitting in the top bar's slot beside the island, so content under it
     starts clear. (Content running under the bars gets the header's height.) */
  &[data-extends-under-bars="false"]:not([data-hidden="true"])
  > *:nth-child(2):not(${StyledBarStrip}) {
    ${provideSafeArea({ top: "0px" })}
  }

  /* Content */
  > *:nth-child(2):not(${StyledBarStrip}) {
    height: 0;
    flex-grow: 1;
    z-index: 0;
    transition: opacity 0.2s ease-in-out;
  }

  &[data-fit-content="true"] {
    > *:nth-child(2):not(${StyledBarStrip}) {
      height: auto;
      max-height: 100%;
    }
  }

  &[data-disabled="true"] {
    > *:nth-child(2):not(${StyledBarStrip}) {
      opacity: 0.5;
    }
  }

  /* Sized to the top safe area, so it's gone wherever nothing sits above the
  content, like iPhone landscape or the iPhone Duo (its status bar is in the
  control strip). */
  > .top-fade {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: ${safeArea.top()};
    background: linear-gradient(rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0.3) 40%, rgba(0, 0, 0, 0));
  }
`;
