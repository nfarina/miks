import { HTMLAttributes, ReactElement, RefObject, use, useEffect, useRef, useState } from "react";
import { CSSTransition, TransitionGroup } from "react-transition-group";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { ErrorBoundary } from "../../components/ErrorBoundary.js";
import { NoContent } from "../../components/NoContent.js";
import { getSwipeFinish, useSwipe } from "../../hooks/useSwipe.js";
import { HostContext } from "../../host/context/HostContext.js";
import { easing } from "../../shared/easing.js";
import { RouterLocation } from "../RouterLocation.js";
import { RouterContext, RouterContextValue } from "../context/RouterContext.js";

export type NavStackAnimation = "slide" | "pop" | "auto" | "none";

export type NavStackItem = {
  key: string;
  childContext: RouterContextValue;
  child: ReactElement<any>;
  ref: RefObject<HTMLDivElement | null>;
  /** Covers the whole of split <Navs>, not just its pane. */
  fullScreen?: boolean;
};

export function NavStack({
  back,
  forward,
  items,
  animation: specifiedAnimation = "auto",
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  back: RouterLocation | null;
  /** The page you last came back from, to swipe forward to again. */
  forward?: { location: RouterLocation; item: NavStackItem } | null;
  items: NavStackItem[];
  animation?: NavStackAnimation;
}) {
  // const stackRef = useRef<HTMLDivElement | null>(null);
  const { history } = use(RouterContext);
  const { container } = use(HostContext);

  const animation = (() => {
    if (specifiedAnimation === "auto") {
      switch (container) {
        case "ios":
          return "slide";
        case "android":
          return "pop";
        default:
          return "none";
      }
    }
    return specifiedAnimation;
  })();

  /**
   * Loops over the stack items and adds `aria-hidden` to all but the last.
   * This is necessary to prevent screen readers from "seeing" the inactive
   * content that's behind the current screen.
   *
   * This is done as DOM operation instead of modifying the `{child}` so that we
   * don't incorrectly assign the attribute to something like a <SomeContext>.
   */
  // useEffect(() => {
  //   const stackEl = stackRef.current;
  //   if (!stackEl) return;

  //   const observeMutations = () => {
  //     for (let i = stackEl.children.length - 1; i >= 0; i--) {
  //       const child = stackEl.children[i];
  //       if (i === stackEl.children.length - 1) {
  //         child.setAttribute("aria-hidden", "false");
  //       } else {
  //         child.setAttribute("aria-hidden", "true");
  //       }
  //     }
  //   };

  //   const observer = new MutationObserver(observeMutations);
  //   observer.observe(stackEl, { childList: true });

  //   return () => observer.disconnect();
  // }, []);

  // On iOS, swipe right from anywhere to go back, as in native apps: the
  // page follows your finger, then slides away or settles back as you let go.
  const stackRef = useRef<HTMLDivElement | null>(null);
  const swipe = useRef<{ item: HTMLElement; width: number } | null>(null);
  const swipes = container === "ios" && animation === "slide";

  // The forward page waits just off-screen, only where you can swipe to it.
  const forwardItem = swipes ? forward?.item : null;
  const rendered = forwardItem ? [...items, forwardItem] : items;

  // The page that was waiting forward slides in when you go to it some other
  // way than swiping (a link to it, say). It's marked arriving from the very
  // render that brings it (as it's still the last forward page), and stays
  // marked until it's there: Safari cuts a transition short the moment its
  // transition property goes away.
  const [lastForwardKey, setLastForwardKey] = useState<string | null>(null);
  const [arrivingKey, setArrivingKey] = useState<string | null>(null);

  useEffect(() => {
    if (lastForwardKey && items.some((item) => item.key === lastForwardKey)) {
      setArrivingKey(lastForwardKey);
    }
    setLastForwardKey(forwardItem?.key ?? null);
  }, [forwardItem?.key]);

  useEffect(() => {
    if (!arrivingKey) return;
    const timeout = setTimeout(() => setArrivingKey(null), ARRIVING_DURATION + 100);
    return () => clearTimeout(timeout);
  }, [arrivingKey]);

  useSwipe(stackRef, {
    enabled: swipes && !!back,
    direction: "right",
    onStart: () => {
      const stack = stackRef.current;
      const item = stack && getTopItem(stack);
      if (!stack || !item) return;
      item.style.transition = "none";
      item.dataset.swiping = "true";
      swipe.current = { item, width: stack.clientWidth };
    },
    onMove: (offset) => {
      if (swipe.current) swipe.current.item.style.transform = `translateX(${offset}px)`;
    },
    onEnd: ({ offset, velocity }) => {
      const swiped = swipe.current;
      swipe.current = null;
      if (!swiped || !back) return;

      const { item, width } = swiped;
      const flung = velocity > SWIPE_BACK_VELOCITY && offset > 10;
      const far = offset > width * SWIPE_BACK_DISTANCE;

      if (flung || far) {
        // Off it goes, carrying on at the speed it was let go, and stays put
        // while the stack lets it go, rather than jumping back for its exit
        // animation (the inline style wins).
        const finish = getSwipeFinish(width + 20 - offset, velocity);
        item.style.transition = `transform ${finish.duration}ms ${finish.easing}`;
        item.style.transform = "translateX(calc(100% + 20px))";
        // Go back once it's off, so the work of navigating doesn't hold up
        // the start of its slide. It waits there as the forward page now,
        // held by the stack's styles.
        const href = back.href();
        setTimeout(() => {
          history.navigate(href);
          whenForward(item, true, () => {
            item.style.transition = "";
            item.style.transform = "";
            delete item.dataset.swiping;
          });
        }, finish.duration);
      } else {
        item.style.transition = `transform 0.3s ${easing.outCubic}`;
        item.style.transform = "";
        setTimeout(() => {
          item.style.transition = "";
          delete item.dataset.swiping;
        }, 300);
      }
    },
  });

  // Swiping left pulls the forward page back in over this one.
  const forwardSwipe = useRef<{ item: HTMLElement; width: number } | null>(null);

  useSwipe(stackRef, {
    enabled: !!forwardItem,
    direction: "left",
    onStart: () => {
      const stack = stackRef.current;
      const item = stack?.querySelector<HTMLElement>(':scope > .item[data-forward="true"]');
      if (!stack || !item) return;
      // Important, to outdo the forward page's own (see StyledNavs).
      item.style.setProperty("transition", "none", "important");
      item.dataset.swiping = "true";
      forwardSwipe.current = { item, width: stack.clientWidth };
    },
    onMove: (offset) => {
      const swiped = forwardSwipe.current;
      if (!swiped) return;
      const position = Math.max(swiped.width + 20 - offset, 0);
      swiped.item.style.setProperty("transform", `translateX(${position}px)`, "important");
    },
    onEnd: ({ offset, velocity }) => {
      const swiped = forwardSwipe.current;
      forwardSwipe.current = null;
      if (!swiped || !forward) return;

      const { item, width } = swiped;
      const flung = velocity > SWIPE_BACK_VELOCITY && offset > 10;
      const far = offset > width * SWIPE_BACK_DISTANCE;
      const going = flung || far;

      // Carrying on at the speed it was let go, if it's going.
      const finish = going
        ? getSwipeFinish(width + 20 - offset, velocity)
        : { duration: 250, easing: easing.outCubic };
      item.style.setProperty("transition", `transform ${finish.duration}ms ${finish.easing}`, "important");
      item.style.setProperty(
        "transform",
        going ? "translateX(0px)" : "translateX(calc(100% + 20px))",
        "important",
      );
      // Once settled, it's the stack's to place again; going, it's on top
      // (navigating only then, so that work doesn't hold up the slide).
      const href = forward.location.href();
      setTimeout(() => {
        const settle = () => {
          item.style.removeProperty("transition");
          item.style.removeProperty("transform");
          delete item.dataset.swiping;
        };
        if (going) {
          history.navigate(href);
          whenForward(item, false, settle);
        } else {
          settle();
        }
      }, finish.duration);
    },
  });

  return (
    <StyledNavs ref={stackRef} data-animation={animation} {...rest}>
      <TransitionGroup component={null}>
        {rendered.map((item) => (
          <CSSTransition
            key={item.key}
            nodeRef={item.ref}
            unmountOnExit
            timeout={{
              enter: animation !== "none" ? 400 + 250 : 0,
              exit: animation !== "none" ? 300 : 0,
            }}
          >
            <div
              className="item"
              ref={item.ref}
              data-full-screen={!!item.fullScreen}
              data-forward={item === forwardItem}
              data-arriving={
                item !== forwardItem && (item.key === lastForwardKey || item.key === arrivingKey)
              }
            >
              <RouterContext value={item.childContext}>
                {/* Per-page, so a screen that throws leaves the rest of the app
                    (tab bar included) usable, and — critically — always offers
                    a way off the broken route. A host that restores the last
                    route on launch turns "blank screen" into a trap you can't
                    relaunch out of. */}
                <ErrorBoundary
                  resetKey={item.childContext.location.href()}
                  fallback={({ reset }) => (
                    <NoContent
                      title="Something went wrong"
                      subtitle="This screen ran into an unexpected problem."
                      action={back ? "Go back" : "Try again"}
                      actionTo={back?.href()}
                      onActionClick={back ? undefined : reset}
                    />
                  )}
                >
                  {item.child}
                </ErrorBoundary>
              </RouterContext>
            </div>
          </CSSTransition>
        ))}
      </TransitionGroup>
    </StyledNavs>
  );
}

/**
 * Once a swiped page has become the forward page (or stopped being it), as
 * the navigation that does it renders, which can take a while on a phone. Only
 * then can its inline styles go without it jumping before the stack's own
 * styles take over. (Or if it's gone, or after a few seconds, regardless.)
 */
function whenForward(item: HTMLElement, forward: boolean, callback: () => void) {
  const done = () => item.dataset.forward === String(forward) || !item.isConnected;
  if (done()) return callback();

  const observer = new MutationObserver(() => {
    if (!done()) return;
    finish();
  });
  const timeout = setTimeout(finish, 3000);

  function finish() {
    observer.disconnect();
    clearTimeout(timeout);
    callback();
  }

  observer.observe(item, { attributes: true, attributeFilter: ["data-forward"] });
}

/** The page on top, not counting the forward one waiting off-screen. */
function getTopItem(stack: HTMLElement): HTMLElement | null {
  const items = [...stack.children] as HTMLElement[];
  return items.filter((item) => item.dataset.forward !== "true").at(-1) ?? null;
}

/** How long (ms) the forward page takes to slide in when you go to it. */
const ARRIVING_DURATION = 400;

/** How fast (px/ms) a page has to be flung right to go back. */
const SWIPE_BACK_VELOCITY = 0.5;
/** Or how much of its width it has to be dragged. */
const SWIPE_BACK_DISTANCE = 0.35;

// We name this <StyledNavs> instead of <StyledNavStack> because <NavStack>
// is internal and rendered only by <Navs>, so it feels more consistent to
// expose <StyledNavs> as a means of styling the parent <Navs>.
export const StyledNavs = styled.div`
  position: relative;
  overflow: hidden;

  > .item {
    position: absolute;
    /* Strangely, "0px" is required (not "0") for the app to look right in FullStory while running in Safari. */
    top: 0px;
    right: 0px;
    bottom: 0px;
    left: 0px;

    /* Whatever the single child of item is. */
    > * {
      position: absolute;
      top: 0px;
      right: 0px;
      bottom: 0px;
      left: 0px;
    }
  }

  /* Disabled for now, seems more annoying than helpful. */
  &[data-render-entire-history="false"] {
    /* Hide all except the last two to (maybe) increase browser render performance. */
    > .item:not(:nth-last-child(-n + 2)) {
      display: none;
    }
  }

  /* Bug fix where previous items could have elements that rendered on top of the last item due to stacking context. */
  > .item:last-child {
    z-index: 2;
  }

  /* The forward page sits on top of the stack, just off-screen, ready to be
     swiped in. Going back makes the page you left this (rather than letting
     it go), so it slides off by its transition instead of an exit animation.
     Important, to outdo the classes of a page entering or leaving. */
  &[data-animation="slide"] > .item[data-forward="true"] {
    z-index: 3;
    transform: translateX(calc(100% + 20px)) !important;
    transition: transform 0.3s ${easing.inCubic} !important;
  }

  &[data-animation="slide"] > .item[data-arriving="true"] {
    transition: transform ${ARRIVING_DURATION}ms ${easing.outCubic};
  }

  /* The real top, under the forward page. */
  > .item:has(+ .item[data-forward="true"]) {
    z-index: 2;
  }

  /* Being swiped back or forward (see useSwipe above). */
  > .item[data-swiping="true"] {
    box-shadow: -4px 0px 20px ${colors.black({ alpha: 0.2 })};
    will-change: transform;
  }

  &[data-animation="slide"] {
    > .item.enter {
      transform: translateX(calc(100% + 20px));
    }

    > .item.enter-active {
      transform: none;
      transition: transform 0.4s ${easing.outCubic};
      /* This makes the animation smoother as React has a chance to render the content first. */
      transition-delay: 250ms;
      box-shadow: -4px 0px 20px ${colors.black({ alpha: 0.2 })};
    }

    > .item.exit {
      transition: transform 0.3s ${easing.inCubic};
      transform: none;
    }

    > .item.exit-active {
      transform: translateX(calc(100% + 20px));
      box-shadow: -4px 0px 20px ${colors.black({ alpha: 0.2 })};
    }
  }

  &[data-animation="pop"] {
    > .item.enter {
      transform: scale(0.9);
      opacity: 0;
    }

    > .item.enter-active {
      transform: none;
      opacity: 1;
      transition:
        transform 0.3s ${easing.outCubic},
        opacity 0.3s ${easing.outCubic};
      /* This makes the animation smoother as React has a chance to render the content first. */
      transition-delay: 250ms;
    }

    > .item.exit {
      transform: none;
      opacity: 1;
    }

    > .item.exit-active {
      transform: scale(0.9);
      opacity: 0;
      transition:
        transform 0.25s ${easing.inCubic},
        opacity 0.25s ${easing.inCubic};
    }
  }
`;
