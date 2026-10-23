import { CSSProperties, ReactNode, use, useLayoutEffect, useRef, useState } from "react";
import { css, keyframes, styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { HotKeyContextDataAttributes, useHotKey } from "../../hooks/useHotKey.js";
import { BarEdgeContext } from "../../host/context/BarEdgeContext.js";
import { HostContext } from "../../host/context/HostContext.js";
import { NO_SAFE_AREA, provideSafeArea, safeArea, padSafeArea } from "../../safearea/safeArea.js";
import { easing } from "../../shared/easing.js";
import { ModalContext } from "../context/ModalContext.js";
import { Modal, useModal } from "../context/useModal.js";
import { useViewportSize } from "../../viewport/viewport.js";
import { StyledBarStrip } from "../../components/BarStrip.js";
import { StyledNavHeader, StyledNavLayout } from "../../router/navs/NavLayout.js";
import { whenFolded } from "../../host/util/fold.js";
import { getSwipeFinish, rubberBand, useSwipe } from "../../hooks/useSwipe.js";

export type SheetAnimation = "slide" | "pop";

export type UseSheetOptions = {
  /**
   * Ensures the dialog cannot be auto-dismissed by clicking outside it or
   * pressing escape. (Desktop presentation only)
   */
  sticky?: boolean;
  forceFullScreen?: boolean;
  /**
   * If defined, the sheet will stretch horizontally and/or vertically to fill
   * the screen up to the given maximum size (in CSS units if supplied).
   */
  stretch?: SheetStretch;
  animation?: SheetAnimation;
  /** Optional delay before the presenting animation begins. */
  delay?: string;
  /** Listens for the ESC key and closes the dialog. Default is true. */
  pressEscapeToClose?: boolean;
  /**
   * Sizes the sheet to its content (what its scrolling area holds) rather
   * than the whole screen: on a phone, between FIT_MIN_HEIGHT and full height;
   * floating, up to its usual height. It follows the content as it changes.
   */
  fit?: boolean;
};

export type SheetStretch = { maxWidth?: string; maxHeight?: string };

export function useSheet<T extends any[]>(
  renderSheet: (...args: T) => ReactNode,
  {
    sticky,
    forceFullScreen = false,
    stretch,
    animation,
    delay,
    pressEscapeToClose,
    fit,
  }: UseSheetOptions = {},
): Modal<T> {
  const modal = useModal((...args: any) => (
    <SheetContainer
      onClose={modal.hide}
      sticky={sticky}
      forceFullScreen={forceFullScreen}
      stretch={stretch}
      pressEscapeToClose={pressEscapeToClose}
      animation={animation}
      delay={delay}
      fit={fit}
      children={renderSheet(...args)}
    />
  ));

  return modal;
}

export const SheetContainer = ({
  children,
  onClose,
  sticky,
  forceFullScreen,
  stretch,
  pressEscapeToClose = true,
  // Provided by <TransitionGroup>.
  in: animatingIn,
  animation,
  delay,
  fit,
  onExited,
}: {
  children: ReactNode;
  onClose: () => void;
  sticky?: boolean;
  forceFullScreen?: boolean;
  stretch?: SheetStretch;
  pressEscapeToClose?: boolean;
  in?: boolean;
  animation?: SheetAnimation;
  delay?: string;
  fit?: boolean;
  onExited?: () => void;
}) => {
  const { container, viewport } = use(HostContext);
  const { allowDesktopPresentation } = use(ModalContext);

  // Mirrors the container query in our styles that floats us like a dialog.
  const wide = useViewportSize().width >= 500;
  const floating = !forceFullScreen && !!allowDesktopPresentation && wide;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resolvedOnClose = sticky ? () => {} : onClose;

  // Listen for the escape key and call onClose if pressed.
  useHotKey(
    "Escape",
    {
      target: containerRef,
      disabled: !pressEscapeToClose,
      // Fire even if you're focused on an input field.
      fireInInputs: "always",
    },
    resolvedOnClose,
  );

  function getAnimation(): SheetAnimation {
    if (animation) {
      // You asked for something specific.
      return animation;
    } else if (container === "ios") {
      return "slide";
    } else if (container !== "android" && !floating) {
      // A phone-sized screen anywhere else (a phone's browser, or a simulated
      // device) slides up a card too.
      return "slide";
    } else {
      return "pop";
    }
  }

  function onAnimationEnd() {
    if (animatingIn === false) {
      onExited?.();
    }
  }

  // On a phone, a sliding sheet is a card, as on iOS: it stops short of the
  // top, over a dimmed page, and drags down to dismiss.
  const card = getAnimation() === "slide" && !floating;
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);

  // The card's height as a swipe began, to fade the backdrop against.
  const swipeHeight = useRef(1);

  function setCardOffset(offset: number) {
    const sheet = sheetRef.current;
    const backdrop = backdropRef.current;
    if (!sheet || !backdrop) return;
    sheet.style.transform = offset !== 0 ? `translateY(${offset}px)` : "";
    backdrop.style.opacity = offset > 0 ? String(1 - Math.min(offset / swipeHeight.current, 1)) : "";
  }

  // Swiping a card down to dismiss it, from anywhere in it that isn't
  // scrolled down. Moves only the card and the backdrop, by their own styles,
  // to keep up with a finger.
  useSwipe(sheetRef, {
    enabled: card && !!animatingIn,
    direction: "down",
    overscroll: true,
    // With a mouse, only the top of the card, and not its buttons.
    allowMouse: (e) => {
      const target = e.target as HTMLElement;
      const top = sheetRef.current?.getBoundingClientRect().top ?? 0;
      return (
        !target.closest("button, a, select, [role='button']") &&
        e.clientY - top <= CARD_MOUSE_DRAG_ZONE
      );
    },
    onStart: () => {
      swipeHeight.current = Math.max(sheetRef.current?.clientHeight ?? 1, 1);
      containerRef.current?.setAttribute("data-dragging", "true");
    },
    // Pulled up, it stretches like a rubber band (into the extra card below
    // the screen, see CARD_STRETCH). A sticky card gives a little, but won't go.
    onMove: (offset) =>
      setCardOffset(
        offset < 0 ? -rubberBand(-offset, CARD_PULL_LIMIT) : sticky ? offset / 4 : offset,
      ),
    onEnd: ({ offset, velocity }) => {
      containerRef.current?.removeAttribute("data-dragging");

      const flung = velocity > CARD_DISMISS_VELOCITY && offset > 10;
      const far = offset > swipeHeight.current * CARD_DISMISS_DISTANCE;

      if (!sticky && (flung || far)) {
        // Slides (and fades) on down from here (see slideDown), carrying on at
        // the speed it was let go.
        const finish = getSwipeFinish(swipeHeight.current + 20 - offset, velocity, {
          min: CARD_DISMISS_MIN_DURATION,
          max: CARD_DISMISS_MAX_DURATION,
        });
        containerRef.current?.style.setProperty("--dismiss-duration", `${finish.duration}ms`);
        containerRef.current?.style.setProperty("--dismiss-easing", finish.easing);
        onClose();
      } else {
        setCardOffset(0);
      }
    },
  });

  // Fitting the content: the sheet's height, less the scrolling area's, plus
  // what that area holds. That holds at whatever height the sheet is now, so
  // it can follow the content as it changes (and the sheet with it). The
  // scrolling area can come later (after loading, say), so watch for it.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const sheet = sheetRef.current;
    if (!fit || !container || !sheet) return;

    let scroller: HTMLElement | null = null;

    function measure() {
      if (!scroller) return;
      const style = getComputedStyle(scroller);
      const children = getInFlowChildren(scroller);
      // Scrollable stretches its last child to fill, so that one's measured by
      // where its own contents end.
      const contents = children.reduce(
        (sum, child, i) =>
          sum + (i === children.length - 1 ? getContentHeight(child) : child.offsetHeight),
        parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      );
      // The sheet without its extra card below the screen (see CARD_STRETCH).
      const sheetHeight = sheet!.clientHeight - parseFloat(getComputedStyle(sheet!).paddingBottom);
      const fitted = sheetHeight - scroller.clientHeight + contents;
      container!.style.setProperty("--fit-height", `${Math.ceil(fitted)}px`);
    }

    const resizes = new ResizeObserver(measure);

    function attach() {
      if (!scroller?.isConnected) scroller = findScroller(sheet!);
      if (!scroller) return;
      resizes.observe(scroller);
      for (const child of scroller.children) resizes.observe(child);
      measure();
    }

    const mutations = new MutationObserver(attach);
    mutations.observe(sheet, { childList: true, subtree: true });
    attach();

    return () => {
      mutations.disconnect();
      resizes.disconnect();
    };
  }, [fit]);

  // We have to do some special handling for when we are being dismissed via
  // "slide" animation while the keyboard is visible. In this case, the keyboard
  // makes our viewport smaller so we need to slide down a lot more to leave
  // the screen, otherwise we'll kind of slide halfway down, sit there for
  // a moment, then vanish. And it's made more complicated by the fact that
  // viewport.keyboardVisible will change mid-slide (because when we start
  // animating out, the keyboard also dismisses). So we'll capture the
  // state of the keyboard and only update it when we transition to animating
  // out while the keyboard is already visible.

  const [keyboardVisible, setKeyboardVisible] = useState(!!viewport.keyboardVisible);

  useLayoutEffect(() => {
    if (!animatingIn && !!viewport.keyboardVisible) {
      setKeyboardVisible(true);
    } else if (animatingIn) {
      setKeyboardVisible(false);
    }
  }, [!!viewport.keyboardVisible, !!animatingIn]);

  const cssProps = {
    "--animation-delay": delay || "0s",
    "--stretch-max-width": stretch?.maxWidth || "",
    "--stretch-max-height": stretch?.maxHeight || "",
  } as CSSProperties;

  return (
    <StyledSheetContainer
      ref={containerRef}
      data-animation={getAnimation()}
      data-stretch-width={!!stretch?.maxWidth}
      data-stretch-height={!!stretch?.maxHeight}
      data-keyboard-visible={keyboardVisible}
      data-allow-desktop-presentation={!forceFullScreen && !!allowDesktopPresentation}
      style={cssProps}
      data-animating-in={animatingIn}
      data-card={card}
      data-fit={!!fit}
      onAnimationEnd={onAnimationEnd}
      // Sheets present in a way that obscures content underneath, so any hotkeys
      // bound to elements underneath the dialog should not fire. This data
      // attribute will achieve that.
      {...HotKeyContextDataAttributes}
    >
      {/* Backdrop is only used on large web browsers. */}
      <div
        className="backdrop"
        ref={backdropRef}
        data-animating-in={animatingIn}
        onClick={resolvedOnClose}
      />
      {/* This container element helps with CSS targeting and also allows the
          child to return different elements from render() without triggering
          extra unwanted CSS "appear" animations. */}
      <div className="sheet" ref={sheetRef}>
        {card && <div className="grabber" />}
        {/* Floating clear of the screen edges, so any bars inside run
            horizontally. A full-screen sheet keeps the host's bar edge. */}
        {floating ? <BarEdgeContext value={null}>{children}</BarEdgeContext> : children}
      </div>
    </StyledSheetContainer>
  );
};

/** How far down from its top a mouse can drag a card (it's all touch). */
const CARD_MOUSE_DRAG_ZONE = 60;
/** How fast (px/ms) a card has to be flung down to dismiss it. */
const CARD_DISMISS_VELOCITY = 0.5;
/** Or how much of its height it has to be dragged down. */
const CARD_DISMISS_DISTANCE = 0.35;
/** How long (ms) a swiped-away card takes to go, at most and least: quicker
 * than a page, as sheets get out of the way on iOS. */
const CARD_DISMISS_MAX_DURATION = 350;
const CARD_DISMISS_MIN_DURATION = 120;

/** An element's children that take up room (not absolutely positioned). */
function getInFlowChildren(element: HTMLElement): HTMLElement[] {
  return ([...element.children] as HTMLElement[]).filter((child) => {
    const { position } = getComputedStyle(child);
    return position !== "absolute" && position !== "fixed";
  });
}

/**
 * How tall an element's contents make it, even if it's been stretched taller:
 * from its top to where its last child ends, plus its padding below.
 */
function getContentHeight(element: HTMLElement): number {
  const children = getInFlowChildren(element);
  if (children.length === 0) return element.offsetHeight;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  // Screen rects are scaled along with a simulated device; layout isn't.
  const scale = element.offsetHeight > 0 ? rect.height / element.offsetHeight : 1;
  const bottom = Math.max(
    ...children.map(
      (child) =>
        (child.getBoundingClientRect().bottom - rect.top) / scale +
        parseFloat(getComputedStyle(child).marginBottom),
    ),
  );
  return bottom + parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
}

/** The first element in a sheet that scrolls vertically, for fitting it. */
function findScroller(sheet: HTMLElement): HTMLElement | null {
  for (const element of sheet.querySelectorAll<HTMLElement>("*")) {
    const { overflowY } = getComputedStyle(element);
    if (overflowY === "auto" || overflowY === "scroll") return element;
  }
  return null;
}

const boxShadow = "0 -4px 20px " + colors.black({ alpha: 0.2 });

const CARD_TOP_GAP = "10px";
/** The least of the screen a fitted card takes. */
const FIT_MIN_HEIGHT = "40%";
/** How far up a card can be pulled. */
const CARD_PULL_LIMIT = 80;
/** How much more card there is below the screen, for that pull to reveal. */
const CARD_STRETCH = "120px";
/** About the screen's own corners, like the system's sheets. */
const CARD_RADIUS = "var(--sheet-corner-radius, 36px)";

const slideUp = keyframes`
  from {
    transform: translateY(100%);
  }
`;

const slideDown = keyframes`
  from {
    /* Prevent user interaction (like double-clicking buttons) while disappearing. */
    pointer-events: none;
  }
  to {
    transform: translateY(calc(100% + 20px));  /* Add 20px for drop shadow. */
  }
`;

// When the keyboard is visible, 100% will only get us halfway down the screen.
// So in that case we'll just double our transform which usually looks OK.
const doubleSlideDown = keyframes`
  from {
    /* Prevent user interaction (like double-clicking buttons) while disappearing. */
    pointer-events: none;
  }
  to {
    transform: translateY(calc(200% + 20px));
  }
`;

const popIn = keyframes`
  from {
    transform: scale(0.9);
    opacity: 0;
  }
`;

const popOut = keyframes`
  from {
    /* Prevent user interaction (like double-clicking buttons) while disappearing. */
    pointer-events: none;
  }
  to {
    transform: scale(0.9);
    opacity: 0;
  }
`;

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
`;

const fadeOut = keyframes`
  from {
    /* Prevent user interaction (like double-clicking buttons) while disappearing. */
    pointer-events: none;
  }
  to {
    opacity: 0;
  }
`;

const StyledSheetContainer = styled.div`
  display: flex;
  flex-flow: column;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;

  > .backdrop {
    z-index: 0;
    position: absolute;
    top: 0px;
    left: 0px;
    right: 0px;
    bottom: 0px;
    background: rgba(0, 0, 0, 0.5);
    display: none;
  }

  > .sheet {
    position: relative;
    z-index: 1;
    flex-grow: 1;
    display: flex;
    flex-flow: column;

    > * {
      flex-grow: 1;
    }

    /* Keeps a sheet's content clear of the safe area along the sides (the
       iPhone Duo's control strip, iPhone landscape), like pages do for
       themselves with padSafeArea(). The header already is. Floating, the
       safe area is zero anyway. */
    ${StyledNavLayout} > *:nth-child(2):not(${StyledBarStrip}) {
      ${padSafeArea("left", "right")}
    }
  }

  &[data-animating-in="true"][data-animation="slide"] {
    > .sheet {
      animation: ${slideUp} 0.5s ${easing.outQuint} backwards;
      /* The 150ms minumum makes the animation smoother as React has a chance to render the content first. */
      animation-delay: calc(150ms + var(--animation-delay));
      box-shadow: ${boxShadow};
    }
  }

  &[data-animating-in="false"][data-animation="slide"] {
    > .sheet {
      /* Make sure to use "forwards" fill mode because there can be a slight
         delay between animation ending and React unmounting us. */
      /* Swiped away, a card goes at the speed it was let go (see onEnd). */
      animation: ${slideDown} var(--dismiss-duration, 0.5s) var(--dismiss-easing, ${easing.outQuint})
        forwards;
      box-shadow: ${boxShadow};
    }
  }

  &[data-animating-in="false"][data-animation="slide"][data-keyboard-visible="true"] {
    > .sheet {
      /* Double our slide when keyboard is visible. */
      animation: ${doubleSlideDown} 0.5s ${easing.outQuint} forwards;
      box-shadow: ${boxShadow};
    }
  }

  &[data-animating-in="true"][data-animation="pop"] {
    > .sheet {
      /* Backwards fill in case of delay. */
      animation: ${popIn} 0.2s ${easing.outCubic} backwards;
      animation-delay: var(--animation-delay);
    }
  }

  &[data-animating-in="false"][data-animation="pop"] {
    /* Make sure to use "forwards" fill mode because there can be a slight
       delay between animation ending and React unmounting us. */
    > .sheet {
      animation: ${popOut} 0.2s ${easing.inCubic} forwards;
    }
  }

  /* A card stops short of the top, over the dimmed page. It's clear of the
     status bar, so its contents needn't be. */
  &[data-card="true"] {
    /* Out here, where the safe area is still the screen's. */
    padding-top: calc(${safeArea.top()} + ${CARD_TOP_GAP});

    > .backdrop {
      display: block;
      background: rgba(0, 0, 0, 0.25);
      transition: opacity 0.5s ${easing.outQuint};
      will-change: opacity;
    }

    /* With the card, which waits a moment to slide up (see slideUp), rather
       than dimming the page first. Backwards, so it's clear while it waits. */
    > .backdrop[data-animating-in="true"] {
      animation: ${fadeIn} 0.5s ${easing.outQuint} backwards;
      animation-delay: calc(150ms + var(--animation-delay));
    }

    /* As long as the card takes to leave, which ends the sheet when either
       finishes (see onAnimationEnd). */
    > .backdrop[data-animating-in="false"] {
      animation: ${fadeOut} var(--dismiss-duration, 0.5s) ${easing.outQuint} forwards;
    }

    > .sheet {
      ${provideSafeArea({ top: "0px" })}
      /* More card below the screen, so pulling it up shows card, not the page
         behind (its contents still end at the screen's edge). */
      margin-bottom: -${CARD_STRETCH};
      padding-bottom: ${CARD_STRETCH};
      background: ${colors.textBackground()};
      border-radius: ${CARD_RADIUS} ${CARD_RADIUS} 0 0;
      overflow: hidden;
      transition: transform 0.5s ${easing.outQuint};
      /* Its own layer, so a swipe only moves it. */
      will-change: transform;

      > .grabber {
        position: absolute;
        z-index: 10;
        top: 5px;
        left: calc(50% - 18px);
        width: 36px;
        height: 5px;
        border-radius: 3px;
        background: ${colors.textSecondary({ alpha: 0.4 })};
        pointer-events: none;
      }
    }

    &[data-dragging="true"] > :is(.sheet, .backdrop) {
      transition: none;
    }

    /* Fitted, it sits at the bottom, as tall as its content (see fit). */
    &[data-fit="true"] > .sheet {
      flex-grow: 0;
      margin-top: auto;
      height: clamp(${FIT_MIN_HEIGHT}, var(--fit-height, 100%), 100%);
      transition:
        transform 0.5s ${easing.outQuint},
        height 0.3s ${easing.outCubic};
    }

    /* (After the above, to win.) */
    &[data-dragging="true"] > :is(.sheet, .backdrop) {
      transition: none;
    }
  }

  /**
   * Sheets aren't typically designed for large viewports. So we'll put them in
   * a floating dialog like useDialog().
   */
  &[data-allow-desktop-presentation="true"] {
    @container viewport (min-width: 500px) {
      padding-top: calc(25px + ${safeArea.top()});
      padding-bottom: calc(25px + ${safeArea.bottom()});
      /* Centered on the screen, not between the side safe areas, which a strip
         down one side (the iPhone Duo) would pull off center. */
      padding-right: calc(25px + max(${safeArea.left()}, ${safeArea.right()}));
      padding-left: calc(25px + max(${safeArea.left()}, ${safeArea.right()}));
      justify-content: center;

      /* Clear of the fold, in the left half, where sheets belong in the book
         pose (dialogs and popups follow the tap instead). */
      ${whenFolded(css`
        padding-right: calc(100% - var(--fold-left) + 25px);
        padding-left: calc(25px + ${safeArea.left()});
      `)}

      > .backdrop {
        display: block;
      }

      > .backdrop[data-animating-in="true"] {
        animation: ${fadeIn} 0.3s ${easing.outQuart};
      }

      > .backdrop[data-animating-in="false"] {
        /* Make sure to use "forwards" fill mode because there can be a slight
            delay between animation ending and React unmounting us. */
        animation: ${fadeOut} 0.3s ${easing.outQuart} forwards;
      }

      > .sheet {
        /* Floating, so we've padded it clear of every screen edge, and of
           any fold. */
        --fold: none;
        ${provideSafeArea(NO_SAFE_AREA)}
        align-self: center;
        width: 390px;
        max-height: 615px;
        box-shadow: 0 5px 22px rgba(0, 0, 0, 0.5);
        border-radius: 16px;
        overflow: hidden;

        /* Rounded overflow doesn't clip a header's backdrop blur, which then
           squares off the top corners; a clip path does. (On the content, so
           it doesn't clip our shadow too.) */
        > * {
          clip-path: inset(0 round 16px);
        }

        /* WebKit doesn't clip the blur by that either, but it does honor the
           blur's own corners. */
        ${StyledNavHeader}::before {
          border-radius: 16px 16px 0 0;
        }
      }
    }
  }

  /* Fitted and floating, as tall as its content, up to its usual height. */
  &[data-allow-desktop-presentation="true"][data-fit="true"] {
    @container viewport (min-width: 500px) {
      > .sheet {
        flex-grow: 0;
        height: var(--fit-height, 615px);
      }
    }
  }

  &[data-allow-desktop-presentation="true"][data-stretch-width="true"] {
    @container viewport (min-width: 500px) {
      > .sheet {
        width: 100%;
        max-width: var(--stretch-max-width);
      }
    }
  }

  &[data-allow-desktop-presentation="true"][data-stretch-height="true"] {
    @container viewport (min-width: 500px) {
      > .sheet {
        max-height: var(--stretch-max-height);
      }
    }
  }
`;
