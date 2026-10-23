import { RefObject, useEffect, useRef } from "react";

export type SwipeDirection = "down" | "right" | "left";

export type SwipeEnd = {
  /** How far it was dragged, in pixels (only negative with overscroll). */
  offset: number;
  /** How fast it was moving when let go, in pixels per millisecond. */
  velocity: number;
};

export interface UseSwipeOptions {
  /** Whether to listen at all. */
  enabled: boolean;
  direction: SwipeDirection;
  /**
   * Whether a mouse press on this target may start a swipe. Mice don't swipe
   * unless you say so (Storybook, mostly).
   */
  allowMouse?: (e: MouseEvent) => boolean;
  /**
   * Lets it be pulled the other way too, past where it started (onMove's
   * offset goes negative), for a rubber band. It only starts that way where
   * there's nothing under the finger to scroll instead.
   */
  overscroll?: boolean;
  /** The swipe has begun: the first move went our way. */
  onStart?: () => void;
  /** Where it's been dragged to, at most once a frame (see overscroll). */
  onMove: (offset: number) => void;
  onEnd: (end: SwipeEnd) => void;
}

/**
 * Follows a finger dragging an element down, right or left, like a sheet
 * being pulled away or a page being swiped back (or forward), and says where
 * it was let go.
 *
 * Which wins, the swipe or a scroll, is decided on the first move: our way,
 * more than across, with whatever's under the finger already scrolled to
 * that edge (and not in a text field). After that the content can't scroll
 * under the swipe, or the swipe start under a scroll. It takes touch events
 * rather than pointer events, since only a touchmove can stop a scroll.
 */
export function useSwipe(ref: RefObject<HTMLElement | null>, options: UseSwipeOptions) {
  // The latest callbacks, without listening anew on every render.
  const latest = useRef(options);

  useEffect(() => {
    latest.current = options;
  });

  const { enabled, direction } = options;

  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;

    const vertical = direction === "down";

    type Gesture = {
      identifier: number;
      start: { x: number; y: number };
      scroller: HTMLElement | null;
      state: "pending" | "swiping" | "ignored";
      offset: number;
      frame: number | null;
      // Recent positions, for the speed you let go at.
      samples: { position: number; time: number }[];
    };

    let gesture: Gesture | null = null;

    function begin(target: EventTarget | null, identifier: number, x: number, y: number) {
      const inField = (target as HTMLElement).closest("input, textarea, [contenteditable]");
      gesture = {
        identifier,
        start: { x, y },
        scroller: getScroller(target as HTMLElement, element!, vertical),
        state: inField ? "ignored" : "pending",
        offset: 0,
        frame: null,
        samples: [],
      };
    }

    function move(e: TouchEvent | MouseEvent, x: number, y: number) {
      if (!gesture || gesture.state === "ignored") return;

      const along =
        direction === "down"
          ? y - gesture.start.y
          : direction === "right"
            ? x - gesture.start.x
            : gesture.start.x - x;
      const across = vertical ? x - gesture.start.x : y - gesture.start.y;

      if (gesture.state === "pending") {
        const atEdge = isScrolledToEdge(gesture.scroller, direction);
        const backward = along < 0 && !!latest.current.overscroll && !gesture.scroller;
        if (along === 0 || Math.abs(across) > Math.abs(along) || (along > 0 ? !atEdge : !backward)) {
          gesture.state = "ignored";
          return;
        }
        gesture.state = "swiping";
        latest.current.onStart?.();
      }

      // Keeps the content from scrolling (or rubber-banding) along with us.
      e.preventDefault();

      gesture.offset = latest.current.overscroll ? along : Math.max(along, 0);

      // Touches can come faster than frames; draw only the latest.
      if (gesture.frame == null) {
        const swiping = gesture;
        swiping.frame = requestAnimationFrame(() => {
          swiping.frame = null;
          if (gesture === swiping) latest.current.onMove(swiping.offset);
        });
      }

      const time = e.timeStamp;
      // Measured along the swipe, so speed comes out positive going its way.
      const position = vertical ? y : direction === "right" ? x : -x;
      gesture.samples = [
        ...gesture.samples.filter((sample) => time - sample.time < 100),
        { position, time },
      ];
    }

    function end() {
      const ended = gesture;
      gesture = null;
      if (ended?.frame != null) cancelAnimationFrame(ended.frame);
      if (ended?.state !== "swiping") return;

      const [first, last] = [ended.samples[0], ended.samples.at(-1)];
      const velocity =
        first && last && last.time > first.time
          ? (last.position - first.position) / (last.time - first.time)
          : 0;

      latest.current.onEnd({ offset: ended.offset, velocity });
    }

    function onTouchStart(e: TouchEvent) {
      if (e.touches.length > 1) {
        gesture = null;
        return;
      }
      const touch = e.changedTouches[0];
      begin(e.target, touch.identifier, touch.clientX, touch.clientY);
    }

    function onTouchMove(e: TouchEvent) {
      if (!gesture) return;
      const touch = [...e.changedTouches].find((t) => t.identifier === gesture!.identifier);
      if (touch) move(e, touch.clientX, touch.clientY);
    }

    function onTouchEnd(e: TouchEvent) {
      if (gesture && [...e.changedTouches].some((t) => t.identifier === gesture!.identifier)) {
        end();
      }
    }

    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0 || !latest.current.allowMouse?.(e)) return;

      begin(e.target, 0, e.clientX, e.clientY);

      function onMouseMove(e: MouseEvent) {
        move(e, e.clientX, e.clientY);
      }

      function onMouseUp() {
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
        end();
      }

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    }

    // The touchmove listener is in place before any touch starts, and not
    // passive: WebKit decides whether a touch can be kept from scrolling by
    // the listeners there when it begins, so one added once the touch has
    // started comes too late, and the content scrolls under the swipe.
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    element.addEventListener("mousedown", onMouseDown);

    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      element.removeEventListener("mousedown", onMouseDown);
    };
  }, [enabled, direction]);
}

/**
 * Whether there's nothing left to scroll the way a swipe would pull: at the
 * top for one down, the left for one right, the right for one left.
 */
function isScrolledToEdge(scroller: HTMLElement | null, direction: SwipeDirection): boolean {
  if (!scroller) return true;
  if (direction === "down") return scroller.scrollTop <= 0;
  if (direction === "right") return scroller.scrollLeft <= 0;
  return scroller.scrollLeft >= scroller.scrollWidth - scroller.clientWidth - 1;
}

/** The nearest element from `target` up to `root` that scrolls on the axis. */
function getScroller(
  target: HTMLElement,
  root: HTMLElement,
  vertical: boolean,
): HTMLElement | null {
  for (let element: HTMLElement | null = target; element && element !== root; element = element.parentElement) {
    const style = getComputedStyle(element);
    const overflow = vertical ? style.overflowY : style.overflowX;
    const scrolls = vertical
      ? element.scrollHeight > element.clientHeight + 1
      : element.scrollWidth > element.clientWidth + 1;
    if ((overflow === "auto" || overflow === "scroll") && scrolls) return element;
  }
  return null;
}

/**
 * How far something pulled `distance` past its limit shows, as on iOS: about
 * half as far to begin with, resisting more the further it goes, and never
 * past `limit`.
 */
export function rubberBand(distance: number, limit: number): number {
  return limit * (1 - 1 / ((distance * 0.55) / limit + 1));
}

/**
 * How to finish a swipe let go at `velocity` (px/ms, its way) with `distance`
 * (px) still to go: about as long as that takes at that speed, easing out
 * from exactly it. So a harder flick carries on faster, as on iOS, rather
 * than every release becoming the same canned animation.
 */
export function getSwipeFinish(
  distance: number,
  velocity: number,
  { min = 150, max = 600 }: { min?: number; max?: number } = {},
): { duration: number; easing: string } {
  // An ease-out that starts this many times as steep as a straight line:
  // enough to slow to a stop, little enough to carry the flick most of the
  // way, so typical flicks (1–5 px/ms) come out noticeably different.
  const steepness = 1.8;
  const speed = Math.max(velocity, 0.01);
  const remaining = Math.max(distance, 1);
  const duration = Math.min(Math.max((steepness * remaining) / speed, min), max);

  // A curve's starting steepness is its first control point's y over x. Match
  // the finger: speed over the average speed of the whole move (capped at 1,
  // the most a curve can do without overshooting).
  const x1 = 0.25;
  const y1 = Math.min((x1 * speed * duration) / remaining, 1);

  return { duration, easing: `cubic-bezier(${x1}, ${y1.toFixed(3)}, 0.4, 1)` };
}
