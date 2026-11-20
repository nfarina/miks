import { getCoordinate, hasTouchIdentifier, isTouchEvent } from "../touchUtils.js";
import { ModalContext } from "../../modals/context/ModalContext.js";
import { Seconds } from "../../shared/timespan.js";
import { use, useEffect, useRef, useState } from "react";
import { DragManager, DragManagerOptions, DragStartHandler, DropHandler } from "./DragManager.js";
import { EdgeScroller } from "./EdgeScroller.js";
import { findAncestor } from "./draggableUtils.js";

const log = (...args: any[]) => {};

/**
 * How far (in pixels) a finger may wander while we wait out the hold that
 * starts a drag. Kept under the distance at which browsers begin a scroll,
 * since a scroll that's already begun can't be taken back.
 */
const HOLD_MOVE_TOLERANCE = 6;

export type DragState = {
  isDragging: boolean;
};

export function useDraggable({
  group,
  onDragStart,
  onDrop,
  disabled,
  handleOnly,
  withinModals,
  ...options
}: DragManagerOptions & {
  group: string;
  /**
   * Called when the user starts dragging an item.
   */
  onDragStart?: DragStartHandler;
  /**
   * Called when the user has finished dragging an item and dropping it on the
   * the given target (element with a `data-draggable-target` attribute).
   */
  onDrop?: DropHandler;
  /**
   * Set to true to (possibly temporarily) disable dragging.
   */
  disabled?: boolean;
  /**
   * Set to true to only allow drags that begin on an explicit drag handle
   * (an element with a `data-is-drag-handle` attribute). Touches anywhere
   * else on the draggable element behave normally (tap, scroll, etc).
   */
  handleOnly?: boolean;
  /**
   * Set to true when the draggable items live inside a modal/popup rather than
   * the page. We normally listen on the modal *context* root, which holds the
   * page content but not the sibling layer that popups/sheets portal into — so
   * without this, drags inside a popup never reach us. When set, we listen on
   * the enclosing modal *provider* (the overlay that contains both).
   */
  withinModals?: boolean;
}): DragState {
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef<number | null>(null); // The `Touch.identifier` of the current drag, if any.
  const onDragStartRef = useRef(onDragStart);
  const onDropRef = useRef(onDrop);

  const { modalContextRoot } = use(ModalContext);

  useEffect(() => {
    // Keep your callbacks fresh even if you change it in the middle of a drag.
    // This is important because your drag handler may have closed over an array
    // of items that have changed (maybe due to a server update) while the user
    // was dragging.
    onDragStartRef.current = onDragStart;
    onDropRef.current = onDrop;
  });

  useEffect(() => {
    if (disabled) return;

    // Normally the modal *context* root (holds page content). For draggables
    // inside a popup, climb to the enclosing modal *provider* overlay, which
    // also contains the layer popups portal into.
    const container = withinModals
      ? ((modalContextRoot.current?.closest("[data-is-modal-provider]") as HTMLElement | null) ??
        modalContextRoot.current)
      : modalContextRoot.current;
    if (!container) return;

    const onStart = (e: TouchEvent | MouseEvent) => {
      log(isTouchEvent(e) ? "onTouchStart" : "onMouseDown");

      // We don't handle multi-touch events.
      if (isTouchEvent(e) && e.touches.length > 1) return;
      if (isDraggingRef.current !== null) return; // Already dragging with one finger!

      const identifier = isTouchEvent(e) ? e.touches[0].identifier : 0; // Arbitrary number.

      if (!(e.target instanceof Element)) return;
      const [dragging, id] = findAncestor(e.target, "data-draggable-id");
      if (!dragging) return;

      // Did you click an explicit drag handle?
      const [isDragHandle] = findAncestor(e.target, "data-is-drag-handle");

      // When handles are the only drag affordance, ignore touches anywhere
      // else on the draggable element.
      if (handleOnly && !isDragHandle) return;

      // We don't want to start dragging inputs that are already focused!
      if (dragging.contains(document.activeElement)) {
        // Unless they are non-text-input elements. We only want to ignore
        // <input> and <textarea>.
        const activeElement = document.activeElement;
        if (
          activeElement instanceof HTMLInputElement ||
          activeElement instanceof HTMLTextAreaElement
        ) {
          // An explicit handle wins over an open text field - dismiss it and
          // drag anyway.
          if (isDragHandle) {
            activeElement.blur();
          } else {
            return;
          }
        }
      }

      const draggingGroup = dragging.getAttribute("data-draggable-group");
      if (draggingGroup !== group) return; // We're not responsible for this item!

      const [root] = findAncestor(e.target, "data-draggable-root");
      if (!root) {
        console.error(
          `A node with draggable-id of ${id} was dragged, but could not find an ancestor with a data-draggable-root attribute. Dragging will not work.`,
        );
        return;
      }

      // Are we already dragging something?
      if (root.hasAttribute("data-dragging-child")) {
        log("The root is already dragging something; ignoring.");
        return;
      }

      // An explicit handle exists only to drag — prevent the mousedown's
      // default (the text-selection anchor) so mouse drags don't paint a
      // selection as the pointer travels across selectable content. (Touch
      // listeners are passive, and touch drags don't select anyway.)
      if (isDragHandle && !isTouchEvent(e)) {
        e.preventDefault();
      }

      // Handles begin dragging immediately; anywhere else needs a brief hold
      // to disambiguate from taps and scrolling.
      const delay = isDragHandle ? 0 : Seconds(0.2);

      log(isTouchEvent(e) ? "onTouchStart (valid)" : "onMouseDown (valid)");

      // Manages the state of the drag operation and the manipulation of the
      // DOM.
      const manager: DragManager = new DragManager(
        root,
        container,
        dragging,
        group,
        options,
        onDragStartRef,
        onDropRef,
      );

      // Scrolling is a separate concern from dragging, so we delegate it to
      // another class.
      const scroller: EdgeScroller = new EdgeScroller(dragging);

      // Set the initial touch position now before we (maybe) delay, so that
      // if you drag quickly, the item "catches up" to the mouse.
      manager.setInitialTouchPosition(getCoordinate(e, identifier, "touches"));

      const timeoutId = setTimeout(() => {
        log(`Begin dragging ${id} in group ${group}`);
        log("startDragging", dragging, identifier);
        isDraggingRef.current = identifier;
        setIsDragging(true);
        manager.startDragging();
      }, delay);

      const start = getCoordinate(e, identifier, "touches");

      const onMove = (e: TouchEvent | MouseEvent) => {
        if (isDraggingRef.current === null && isTouchEvent(e)) {
          // A finger resting on the screen is never perfectly still, so a
          // little movement while we wait out the hold isn't a scroll yet.
          const now = getCoordinate(e, identifier, "changedTouches");
          const distance =
            start && now ? Math.hypot(now.x - start.x, now.y - start.y) : Infinity;
          if (distance <= HOLD_MOVE_TOLERANCE) return;

          // Cancel the whole operation, you're likely trying to scroll.
          log("onTouchMove (canceling)");
          cleanup();
          return;
        }

        log(Date.now(), isTouchEvent(e) ? "onTouchMove" : "onMouseMove");

        // Pull out the right touch.
        const coordinate = getCoordinate(e, identifier, "changedTouches");

        if (!coordinate) {
          // Bad touch! (not ours)
          return;
        }

        e.preventDefault();
        manager.drag(coordinate);
        scroller.drag(coordinate);
      };

      const onCancel = (e: TouchEvent) => {
        if (isTouchEvent(e) && !hasTouchIdentifier(e.changedTouches, identifier)) {
          log("ignoring onTouchCancel");
          return;
        }
        log("onTouchCancel");
        cleanup();
      };

      const onEnd = (e: TouchEvent | MouseEvent) => {
        if (isTouchEvent(e) && !hasTouchIdentifier(e.changedTouches, identifier)) {
          log("ignoring onTouchEnd");
          return;
        }
        log(isTouchEvent(e) ? "onTouchEnd" : "onMouseUp");
        cleanup();
      };

      if (isTouchEvent(e)) {
        // We have to explicitly set passive: false here because we call
        // preventDefault in onTouchMove.
        root.addEventListener("touchmove", onMove, {
          passive: false,
        });
        root.addEventListener("touchcancel", onCancel);
        root.addEventListener("touchend", onEnd);
      } else {
        root.addEventListener("mousemove", onMove);
        root.addEventListener("mouseup", onEnd);
      }

      const cleanup = () => {
        isDraggingRef.current = null;
        setIsDragging(false);
        if (isTouchEvent(e)) {
          root.removeEventListener("touchmove", onMove);
          root.removeEventListener("touchcancel", onCancel);
          root.removeEventListener("touchend", onEnd);
        } else {
          root.removeEventListener("mousemove", onMove);
          root.removeEventListener("mouseup", onEnd);
        }
        clearTimeout(timeoutId);
        manager.stopDragging();
        scroller.stopScrolling();
      };
    };

    // I wish I could use onPointerDown etc. since it's supposed to
    // unify mouse and touch events, but you can't prevent scrolling via
    // preventDefault in pointermove events like you can with touchmove.
    container.addEventListener("touchstart", onStart, { passive: true });
    container.addEventListener("mousedown", onStart);

    return () => {
      container.removeEventListener("touchstart", onStart);
      container.removeEventListener("mousedown", onStart);
    };
  }, [modalContextRoot.current, disabled, handleOnly, withinModals]);

  return { isDragging };
}
