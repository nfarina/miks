import { Children, createContext, HTMLAttributes, use, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import styled from "styled-components";
import { colors, shadows } from "../colors/colors.js";
import { provideSafeArea } from "../safearea/safeArea.js";
import { ElementSize, useElementSize } from "../hooks/useElementSize.js";
import { HotKey, useHotKey } from "../hooks/useHotKey.js";
import { useLocalStorage } from "../hooks/useLocalStorage.js";
import { ToolbarPanelButton } from "./toolbar/Toolbar.js";
import { ToolbarContext } from "./toolbar/ToolbarContext.js";
import { getCoordinate, hasTouchIdentifier, isTouchEvent } from "./touchUtils.js";

export const PanelToggleInsertionPoint = "SidebarToggle";

export type PanelEdge = "left" | "right" | "top" | "bottom";

export type PanelLayoutMode = "auto" | "overlay" | "shrink";

// The maximum panel size is the size of the container minus a bit
// (so you can still drag it smaller in case it butts up against another
// PanelLayout which is also draggable!).
const GUTTER_SIZE = 50;

// We allow you to define a default "natural" size for the panel, and if you
// do, we'll snap to it if you drag this close to it.
const DEFAULT_SIZE_SNAP = 12;

export function PanelLayout({
  edge = "right",
  panelMinSize = 275,
  panelMaxSize = Number.MAX_SAFE_INTEGER,
  panelDefaultSize = 375,
  contentMinSize = 375,
  panelVisible = false,
  onPanelVisibleChange,
  hideBorder = false,
  hideDragHandle = false,
  hideToolbarButton = false,
  restorationKey,
  mode = "auto",
  hotkey: hotKey = "ctrl+e",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & {
  /** The edge of the container child to place the panel on. */
  edge?: PanelEdge;
  /** The "natural" (and default) size of the panel. */
  panelDefaultSize?: number;
  /** How many pixels on each side of the default size will cause a snap to the default size, or zero for no snapping. */
  panelDefaultSizeSnap?: number;
  /** The minimum size of the panel. */
  panelMinSize?: number;
  /** The maximum size of the panel. */
  panelMaxSize?: number;
  /** The minimum size of the content area. */
  contentMinSize?: number;
  /** Whether the panel is currently visible. */
  panelVisible?: boolean;
  /** Called when the panel visibility changes by clicking outside (in overlay mode) or by toggling the toolbar button. */
  onPanelVisibleChange?: (visible: boolean) => void;
  /** Whether to hide the dragger "pill" which helps on mobile. */
  hideDragHandle?: boolean;
  /** Whether to hide the toolbar button, which we render through a portal. */
  hideToolbarButton?: boolean;
  /** Whether to hide the border of the panel. */
  hideBorder?: boolean;
  /**
   * Allows the parent component to store the panel size in a persistent way.
   * This could be a string but then it's easy to forget to change the string
   * when copy/pasting code, so it's a function instead, typically your
   * component function, which we'll access the `name` property of.
   */
  restorationKey: Function | symbol;
  /** The layout mode to use. */
  mode?: PanelLayoutMode;
  /** The hotkey to toggle the panel. Set to null to disable hotkey. */
  hotkey?: HotKey | null;
}) {
  const layout = edge === "top" || edge === "bottom" ? "vertical" : "horizontal";
  const ref = useRef<HTMLDivElement>(null);
  // We must use a ref instead of querySelector(".dragger") because PanelLayouts
  // nest, and an unscoped query can bind our drag listeners to a descendant
  // layout's dragger, leaving our own dragger inert.
  const draggerRef = useRef<HTMLDivElement>(null);
  const { isDefaultContext, getInsertionRef } = use(ToolbarContext);

  const key = typeof restorationKey === "symbol" ? String(restorationKey) : restorationKey.name;

  // Persist the panel size across window reloads.
  let [initialPanelSize, setInitialPanelSize] = useLocalStorage<number | null>(
    `PanelLayout:${key}:initialPanelSize`,
    null,
  );

  // Remember if the user made the panel as large as possible.
  const [panelMaximized, setPanelMaximized] = useLocalStorage(
    `PanelLayout:${key}:panelMaximized`,
    false,
  );

  // We need to remember the mode we actually decided to use (if auto),
  // so we can pass it through to the context.
  const [resolvedMode, setResolvedMode] = useState<PanelLayoutMode>(mode);

  useHotKey(hotKey, { target: ref }, () => {
    onPanelVisibleChange?.(!panelVisible);
  });

  // Update the layout when our element size changes, or if any of the
  // size-related properties change.
  useElementSize(ref, updateLayout, [
    panelDefaultSize,
    panelMinSize,
    panelMaxSize,
    contentMinSize,
    mode,
  ]);

  function updateLayout(newSize?: ElementSize) {
    const container = ref.current;
    if (!container) return;

    // We want to adjust all sizing properties using CSS variables without
    // re-rendering the component, for performance reasons.

    // Do we have a CSS var directly stored at "--panel-size"?
    let panelSize = parseInt(container.style.getPropertyValue("--panel-size") || "-1");

    if (panelSize < 0) {
      // No CSS var, so we need to calculate it.
      panelSize = initialPanelSize ?? panelDefaultSize;

      // Set the initial panel size.
      container.style.setProperty("--panel-size", panelSize + "px");
      container.style.setProperty("--bounce-offset", "0px");
    }

    // Enforce the minimum panel size.
    if (panelSize < panelMinSize) {
      panelSize = panelMinSize;
      container.style.setProperty("--panel-size", panelSize + "px");
    }

    // Enforce the maximum panel size.
    let resolvedPanelMaxSize = Math.max(
      layout === "vertical"
        ? container.clientHeight - GUTTER_SIZE
        : container.clientWidth - GUTTER_SIZE,
      0,
    );

    // Further restrict the panel max size if it's been explicitly set.
    if (panelMaxSize !== undefined) {
      resolvedPanelMaxSize = Math.min(resolvedPanelMaxSize, panelMaxSize);
    }

    // If we are being updated because of a change in our size (that isn't
    // because the user is dragging us), then we should snap to the max width
    // if we were already at the max width.
    const userIsResizing = !newSize;

    if (panelSize > resolvedPanelMaxSize || (panelMaximized && !userIsResizing)) {
      panelSize = resolvedPanelMaxSize;
      container.style.setProperty("--panel-size", panelSize + "px");
    }

    // If the user isn't resizing and our initial size is null, then we
    // want to be at the default size.
    if (!userIsResizing && initialPanelSize === null) {
      panelSize = panelDefaultSize;
      container.style.setProperty("--panel-size", panelSize + "px");
    }

    // How much room do we have left for the content?
    const contentSize =
      layout === "vertical"
        ? container.clientHeight - panelSize
        : container.clientWidth - panelSize;

    const finalMode =
      mode === "auto"
        ? // If the content width is less than the minimum, we need to use overlay
          // mode and make the panel cover the content.
          contentSize < contentMinSize
          ? "overlay"
          : "shrink"
        : mode;

    if (resolvedMode !== finalMode) {
      setResolvedMode(finalMode);
    }

    container.setAttribute("data-mode", finalMode);

    // Now that we've set the initial layout, we can enable transitions.
    container.setAttribute("data-transitions-enabled", "true");
  }

  const toggleButton = (
    <ToolbarPanelButton
      edge={edge}
      onClick={() => onPanelVisibleChange?.(!panelVisible)}
      active={panelVisible}
    />
  );

  const insertionEl = !isDefaultContext && getInsertionRef(PanelToggleInsertionPoint).current;

  //
  // Dragging.
  //

  useEffect(() => {
    const container = ref.current;
    const dragger = draggerRef.current;
    if (!container || !dragger) return;

    // In case this effect is run due to its dependencies changing, update
    // the layout to reflect the current state.
    updateLayout();

    const onStart = (e: TouchEvent | MouseEvent) => {
      // console.log(isTouchEvent(e) ? "onTouchStart" : "onMouseDown");

      const panelSize = parseInt(container.style.getPropertyValue("--panel-size") || "-1");

      // We don't handle multi-touch events.
      if (isTouchEvent(e) && e.touches.length > 1) return;

      // The maximum panel size is the size of the container minus the gutter.
      let resolvedPanelMaxSize = Math.max(
        layout === "vertical"
          ? container.clientHeight - GUTTER_SIZE
          : container.clientWidth - GUTTER_SIZE,
        0,
      );

      // Further restrict the panel max size if it's been explicitly set.
      if (panelMaxSize !== undefined) {
        resolvedPanelMaxSize = Math.min(resolvedPanelMaxSize, panelMaxSize);
      }

      const identifier = isTouchEvent(e) ? e.touches[0].identifier : 0; // Arbitrary number.

      const initialPosition = getCoordinate(e, identifier);
      if (!initialPosition) return;

      const startSize = panelSize;

      const onMove = (e: TouchEvent | MouseEvent) => {
        // console.log(
        //   Date.now(),
        //   isTouchEvent(e) ? "onTouchMove" : "onMouseMove",
        // );

        // Pull out the right touch.
        const coordinate = getCoordinate(e, identifier, "changedTouches");

        if (!coordinate) {
          // Bad touch! (not ours)
          return;
        }

        e.preventDefault();

        const diff = (() => {
          switch (edge) {
            case "top":
              return coordinate.y - initialPosition.y;
            case "right":
              return initialPosition.x - coordinate.x;
            case "bottom":
              return initialPosition.y - coordinate.y;
            case "left":
              return coordinate.x - initialPosition.x;
          }
        })();
        const draggedSize = startSize + diff;
        let newSize = draggedSize;

        // We want to "snap" to the default width if we are within a few
        // pixels of it. But if the default width is close to the
        // min width, it's not worth snapping to it.
        if (
          panelDefaultSize > panelMinSize + DEFAULT_SIZE_SNAP &&
          Math.abs(newSize - panelDefaultSize) < DEFAULT_SIZE_SNAP
        ) {
          newSize = panelDefaultSize;
        }

        // Clamp the size to the min and max sizes.
        newSize = Math.max(panelMinSize, Math.min(resolvedPanelMaxSize, newSize));

        container.style.setProperty("--panel-size", newSize + "px");

        // We want to give you feedback if you are at the max or min sizes
        // by allowing you to "overdrag" and showing the panel at your dragged
        // size temporarily, then snapping back to the max or min size. This
        // should behave just like bounce scrolling on iOS, where the scroll
        // amount changes by 1/3 of the distance to the max or min size.
        // We'll set a "--bounce-offset" CSS var to add to the size to
        // show the panel at the dragged size temporarily.
        if (draggedSize > resolvedPanelMaxSize) {
          container.style.setProperty(
            "--bounce-offset",
            (draggedSize - resolvedPanelMaxSize) / 3 + "px",
          );
        } else if (draggedSize < panelMinSize) {
          container.style.setProperty("--bounce-offset", (draggedSize - panelMinSize) / 3 + "px");
        } else {
          container.style.setProperty("--bounce-offset", "0px");
        }

        updateLayout();
      };

      const onCancel = (e: TouchEvent | MouseEvent) => {
        if (isTouchEvent(e) && !hasTouchIdentifier(e.changedTouches, identifier)) {
          // console.log("ignoring onTouchCancel");
          return;
        }
        // console.log("onTouchCancel");
        cleanup();
      };

      const onEnd = (e: TouchEvent | MouseEvent) => {
        if (isTouchEvent(e) && !hasTouchIdentifier(e.changedTouches, identifier)) {
          // console.log("ignoring onTouchEnd");
          return;
        }
        // console.log(isTouchEvent(e) ? "onTouchEnd" : "onMouseUp");
        cleanup();
      };

      // Set the data-dragging attribute to prevent animation.
      container.setAttribute("data-dragging", "true");

      if (isTouchEvent(e)) {
        // We have to explicitly set passive: false here because we call
        // preventDefault in onTouchMove.
        window.addEventListener("touchmove", onMove, {
          passive: false,
        });
        window.addEventListener("touchcancel", onCancel);
        window.addEventListener("touchend", onEnd);
      } else {
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onEnd);
      }

      const cleanup = () => {
        if (isTouchEvent(e)) {
          window.removeEventListener("touchmove", onMove);
          window.removeEventListener("touchcancel", onCancel);
          window.removeEventListener("touchend", onEnd);
        } else {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onEnd);
        }

        // Reset the data-dragging attribute.
        container.removeAttribute("data-dragging");

        // What is the new size?
        const newSize = parseInt(container.style.getPropertyValue("--panel-size") || "-1");

        // Reset the "--bounce-offset" CSS var.
        container.style.setProperty("--bounce-offset", "0px");

        // Persist the new size, making it null if it's the default size.
        // This way if the default size changes, we don't persist the old
        // size.
        setInitialPanelSize(newSize === panelDefaultSize ? null : newSize);

        // If the user dragged the panel to the max, remember that.
        setPanelMaximized(newSize === resolvedPanelMaxSize);
      };

      // We need to prevent the default click handling behavior, otherwise
      // the browser may initiate a native drag operation.
      e.preventDefault();
    };

    // I wish I could use onPointerDown etc. since it's supposed to
    // unify mouse and touch events, but you can't prevent scrolling via
    // preventDefault in pointermove events like you can with touchmove.
    dragger.addEventListener("touchstart", onStart, { passive: false });
    dragger.addEventListener("mousedown", onStart);

    return () => {
      dragger.removeEventListener("touchstart", onStart);
      dragger.removeEventListener("mousedown", onStart);
    };
  }, [
    edge,
    layout,
    panelMinSize,
    panelMaxSize,
    panelDefaultSize,
    contentMinSize,
    initialPanelSize,
    panelMaximized,
    resolvedMode,
    mode,
  ]);

  // Pull our the content and panel elements from our children. The content
  // should be the first child, and the panel should be the second child.
  const [content, panel, ...restChildren] = Children.toArray(children);

  // We spread these around to many elements so the CSS is more readable.
  const dataAttributes = {
    "data-layout": layout,
    "data-panel-edge": edge,
    "data-panel-visible": panelVisible,
    "data-hide-drag-handle": hideDragHandle,
    "data-hide-border": hideBorder,
  };

  const context: PanelLayoutContextValue = {
    panelVisible,
    setPanelVisible: (visible) => onPanelVisibleChange?.(visible),
    panelMode: resolvedMode,
  };

  return (
    <PanelLayoutContext value={context}>
      <StyledPanelLayout ref={ref} {...dataAttributes} {...rest}>
        {insertionEl && !hideToolbarButton && createPortal(toggleButton, insertionEl)}
        <div className="content" {...dataAttributes}>
          {content}
        </div>
        <div className="panel" {...dataAttributes} inert={!panelVisible}>
          {panel}
          <div className="dragger" ref={draggerRef} {...dataAttributes}>
            <div className="drag-handle" {...dataAttributes}>
              <div className="drag-handle-grabber" />
            </div>
          </div>
        </div>
        <div
          className="overlay"
          {...dataAttributes}
          onClick={() => onPanelVisibleChange?.(false)}
        />
        {/* For non-rendering children, like insertion points. */}
        {restChildren}
      </StyledPanelLayout>
    </PanelLayoutContext>
  );
}

export const StyledPanelLayout = styled.div`
  display: flex;
  flex-flow: column;
  overflow: hidden;
  position: relative;

  --drag-edge-size: 10px; /* How many pixels on either side of the panel edge should be used for drag operations. */
  --drag-handle-padding: 6px; /* How much extra hit area to give the drag handle. */
  --drag-handle-length: calc(38px + var(--drag-handle-padding) * 2);
  --drag-handle-thickness: calc(7px + var(--drag-handle-padding) * 2);
  --drag-handle-offset: 6px; /* How far away from the edge of the panel the drag handle should float. Default is to try and center inside the scroller pill on iOS/macOS. */
  --shadow-padding: 25px; /* How much padding to add to compensate for our shadow possibly showing oustide our bounds when we're hidden. */
  --panel-border: 1px solid ${colors.separator()};

  &[data-hide-border="true"] {
    --panel-border: none;
  }

  /*
   * Content.
   */

  > .content {
    height: 0;
    flex-grow: 1;
    z-index: 0;
    box-sizing: border-box;
    display: flex;
    flex-flow: column;

    &[data-panel-edge="top"] {
      margin-top: calc(var(--panel-size) + var(--bounce-offset));
    }

    &[data-panel-edge="right"] {
      margin-right: calc(var(--panel-size) + var(--bounce-offset));
    }

    &[data-panel-edge="bottom"] {
      margin-bottom: calc(var(--panel-size) + var(--bounce-offset));
    }

    &[data-panel-edge="left"] {
      margin-left: calc(var(--panel-size) + var(--bounce-offset));
    }

    /* The content should exactly fill the container without possibility of enlarging. */
    > * {
      height: 0;
      flex-grow: 1;
    }
  }

  /*
   * Overlay. Only used when panel is floating over content.
   */

  > .overlay {
    position: absolute;
    z-index: 1;
    top: 0;
    bottom: 0;
    left: 0;
    right: 0;
    background: ${colors.black({ alpha: 0.2 })};
    opacity: 0;
    pointer-events: none;

    @media (prefers-color-scheme: dark) {
      background: ${colors.black({ alpha: 0.5 })};
    }
  }

  /*
   * Panel.
   */

  > .panel {
    position: absolute;
    z-index: 2;
    background: ${colors.textBackground()};
    flex-shrink: 0;
    box-sizing: border-box;
    display: flex;
    flex-flow: column;

    &[data-panel-edge="top"] {
      top: 0;
      left: 0;
      right: 0;
      height: calc(var(--panel-size));
      transform: translateY(calc(var(--bounce-offset) * 1));
      max-height: 100%;
      border-bottom: var(--panel-border);
    }

    &[data-panel-edge="right"] {
      top: 0;
      bottom: 0;
      right: 0;
      width: calc(var(--panel-size));
      transform: translateX(calc(var(--bounce-offset) * -1));
      max-width: 100%;
      border-left: var(--panel-border);
    }

    &[data-panel-edge="bottom"] {
      bottom: 0;
      left: 0;
      right: 0;
      height: calc(var(--panel-size));
      transform: translateY(calc(var(--bounce-offset) * -1));
      max-height: 100%;
      border-top: var(--panel-border);
    }

    &[data-panel-edge="left"] {
      top: 0;
      bottom: 0;
      left: 0;
      width: calc(var(--panel-size));
      transform: translateX(calc(var(--bounce-offset) * 1));
      max-width: 100%;
      border-right: var(--panel-border);
    }

    /* The panel should exactly fill the container without possibility of enlarging. */
    > *:not(.dragger) {
      height: 0;
      flex-grow: 1;
    }
  }

  /*
   * Dragger.
   */

  > .panel > .dragger {
    position: absolute;
    z-index: 9999;

    &[data-layout="horizontal"] {
      width: var(--drag-edge-size);
      cursor: ew-resize;
    }

    &[data-layout="vertical"] {
      height: var(--drag-edge-size);
      cursor: ns-resize;
    }

    /* Put the drag strip straddling the panel edge. */

    &[data-panel-edge="top"] {
      left: 0;
      right: 0;
      bottom: 0;
      transform: translateY(50%);
    }

    &[data-panel-edge="right"] {
      top: 0;
      bottom: 0;
      left: 0;
      transform: translateX(-50%);
    }

    &[data-panel-edge="bottom"] {
      left: 0;
      right: 0;
      top: 0;
      transform: translateY(-50%);
    }

    &[data-panel-edge="left"] {
      top: 0;
      bottom: 0;
      right: 0;
      transform: translateX(50%);
    }

    > .drag-handle {
      position: absolute;
      /* Center the drag handle inside the drag strip by default. */
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      box-sizing: border-box;
      border-radius: 9999px;
      padding: var(--drag-handle-padding);

      &[data-layout="horizontal"] {
        width: var(--drag-handle-thickness);
        height: var(--drag-handle-length);
      }

      &[data-layout="vertical"] {
        width: var(--drag-handle-length);
        height: var(--drag-handle-thickness);
      }

      &[data-panel-edge="top"] {
        /* Float the handle under the panel's bottom edge. */
        transform: translate(-50%, calc(-50% + var(--drag-handle-offset)));
      }

      &[data-panel-edge="right"] {
        /* Float the handle to the left of the edge. */
        transform: translate(calc(-50% - var(--drag-handle-offset)), -50%);
      }

      &[data-panel-edge="bottom"] {
        /* Float the handle over the panel's top edge. */
        transform: translate(-50%, calc(-50% - var(--drag-handle-offset)));
      }

      &[data-panel-edge="left"] {
        /* Float the handle to the right of the edge. */
        transform: translate(calc(-50% + var(--drag-handle-offset)), -50%);
      }

      &[data-hide-drag-handle="true"] {
        display: none;
      }

      /* Separate element so the hit area for the handle is larger. */
      > .drag-handle-grabber {
        box-sizing: border-box;
        width: 100%;
        height: 100%;
        border-radius: 9999px;
        background-color: ${colors.textSecondary()};
        transition: background-color 0.2s ease-in-out;
        border: 1px solid ${colors.textBackground()};
      }
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        > .drag-handle {
          > .drag-handle-grabber {
            background-color: ${colors.mediumBlue()};
          }
        }
      }
    }
  }

  /*
   * Hiding the panel.
   */

  &[data-panel-visible="false"] {
    /* Remove all space reserved for the panel. */
    > .content {
      margin: 0;
    }

    /* Animate the panel out of view in the correct direction. */
    > .panel {
      &[data-panel-edge="top"] {
        transform: translateY(calc(0px - var(--panel-size) - var(--shadow-padding)));
      }

      &[data-panel-edge="right"] {
        transform: translateX(calc(var(--panel-size) + var(--shadow-padding)));
      }

      &[data-panel-edge="bottom"] {
        transform: translateY(calc(var(--panel-size) + var(--shadow-padding)));
      }

      &[data-panel-edge="left"] {
        transform: translateX(calc(0px - var(--panel-size) - var(--shadow-padding)));
      }
    }
  }

  /*
   * Safe area. The panel runs along one edge of the screen, so its inner edge
   * needs no inset, and while it takes room beside the content (not over it),
   * neither does the content's edge beside it.
   */

  > .panel {
    &[data-panel-edge="top"] {
      ${provideSafeArea({ bottom: "0px" })}
    }

    &[data-panel-edge="right"] {
      ${provideSafeArea({ left: "0px" })}
    }

    &[data-panel-edge="bottom"] {
      ${provideSafeArea({ top: "0px" })}
    }

    &[data-panel-edge="left"] {
      ${provideSafeArea({ right: "0px" })}
    }
  }

  &:not([data-mode="overlay"])[data-panel-visible="true"] > .content {
    &[data-panel-edge="top"] {
      ${provideSafeArea({ top: "0px" })}
    }

    &[data-panel-edge="right"] {
      ${provideSafeArea({ right: "0px" })}
    }

    &[data-panel-edge="bottom"] {
      ${provideSafeArea({ bottom: "0px" })}
    }

    &[data-panel-edge="left"] {
      ${provideSafeArea({ left: "0px" })}
    }
  }

  /*
   * Overlay mode.
   */

  &[data-mode="overlay"] {
    > .content {
      margin: 0;
    }

    > .panel {
      &[data-panel-edge="top"] {
        box-shadow: 0 4px 12px ${colors.black({ alpha: 0.5 })};
        @media (prefers-color-scheme: dark) {
          box-shadow: 0 4px 12px ${colors.black()};
        }
      }

      &[data-panel-edge="right"] {
        box-shadow: -4px 0 12px ${colors.black({ alpha: 0.5 })};
        @media (prefers-color-scheme: dark) {
          box-shadow: -4px 0 12px ${colors.black()};
        }
      }

      &[data-panel-edge="bottom"] {
        box-shadow: 0 -4px 12px ${colors.black({ alpha: 0.5 })};
        @media (prefers-color-scheme: dark) {
          box-shadow: 0 -4px 12px ${colors.black()};
        }
      }

      &[data-panel-edge="left"] {
        box-shadow: 4px 0 12px ${colors.black({ alpha: 0.5 })};
        @media (prefers-color-scheme: dark) {
          box-shadow: 4px 0 12px ${colors.black()};
        }
      }
    }

    /* Add a shadow to the handle when overlaying content, to match the panel. */
    > .dragger > .drag-handle > .drag-handle-grabber {
      box-shadow: ${shadows.cardSmall()};
    }

    /* Use the overlay. */
    &[data-panel-visible="true"] {
      > .overlay {
        opacity: 1;
        pointer-events: auto;
      }
    }
  }

  /*
   * Transition animations for panel and overlay.
   */

  &[data-transitions-enabled="true"] {
    > .content {
      transition: margin 0.2s ease-in-out;
    }

    > .panel {
      transition:
        transform 0.2s ease-in-out,
        width 0.2s ease-in-out,
        height 0.2s ease-in-out;
    }

    > .overlay {
      transition: opacity 0.2s ease-in-out;
    }
  }

  /*
   * Visual state while dragging.
   */

  &[data-dragging="true"] {
    /* Disable scrolling while dragging. */
    touch-action: none;

    /* Disable transitions. */
    > * {
      transition: none !important;
    }

    /* Disable pointer events on our content children, in case one of them
       contains an iframe that's capturing the pointer events. */
    > .content,
    > .panel {
      > * {
        pointer-events: none;
      }

      > .dragger {
        > .drag-handle > .drag-handle-grabber {
          background-color: ${colors.mediumBlue()};
          transition: none;
        }
      }
    }
  }
`;

//
// Context
//

export type PanelLayoutContextValue = {
  panelVisible: boolean;
  setPanelVisible: (visible: boolean) => void;
  panelMode: PanelLayoutMode;
};

export const PanelLayoutContext = createContext<PanelLayoutContextValue>({
  panelVisible: false,
  setPanelVisible: () => {},
  panelMode: "auto",
});
