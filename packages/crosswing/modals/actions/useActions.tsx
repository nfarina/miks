import { ReactElement, useRef } from "react";
import { keyframes, styled } from "styled-components";
import { HotKeyContextDataAttributes, useHotKey } from "../../hooks/useHotKey.js";
import { NO_SAFE_AREA, provideSafeArea, safeArea } from "../../safearea/safeArea.js";
import { easing } from "../../shared/easing.js";
import { Modal, useModal } from "../context/useModal.js";
import { ActionItem, ActionMenu } from "./ActionMenu.js";

export * from "./ActionMenu.js";

/**
 * @deprecated Use a popup menu instead (`usePopup` with `PopupMenu`), from a
 * button: an action sheet is an old iOS idiom that apps here no longer use.
 */
export function useActions<T extends any[]>(actions: (...args: T) => ActionItem[]): Modal<T> {
  const modal = useModal((...args: T) => {
    const items = actions(...args);

    return (
      <ActionContainer onClose={modal.hide}>
        <ActionMenu onClose={modal.hide} items={items} />
      </ActionContainer>
    );
  });

  return modal;
}

export const ActionContainer = ({
  children,
  onClose,
  // Provided by <TransitionGroup>.
  in: animatingIn,
  onExited,
}: {
  children: ReactElement<any>;
  onClose: () => void;
  in?: boolean;
  onExited?: () => void;
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Listen for the escape key and call onClose if pressed.
  useHotKey("Escape", { target: containerRef }, onClose);

  function onAnimationEnd() {
    if (animatingIn === false) {
      onExited?.();
    }
  }

  return (
    <StyledActionContainer
      ref={containerRef}
      data-animating-in={animatingIn}
      onAnimationEnd={onAnimationEnd}
      // Dialogs present in a way that obscures content underneath, so any hotkeys
      // bound to elements underneath the dialog should not fire. This data
      // attribute will achieve that.
      {...HotKeyContextDataAttributes}
    >
      <div className="backdrop" onClick={onClose} />
      {/* This container element helps with CSS targeting and also allows the
          child to return different elements from render() without triggering
          extra unwanted CSS "appear" animations. */}
      <div className="actions">{children}</div>
    </StyledActionContainer>
  );
};

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
`;

const fadeOut = keyframes`
  to {
    opacity: 0;
  }
`;

const slideUp = keyframes`
  from {
    transform: translateY(calc(100% + 10px + var(--actions-safe-area-bottom)));
  }
  /* For some reason we have to explicitly define the "to" state to make
     it work in Safari. Otherwise it just "appears" at the end of the
     animation. */
  to {
    transform: none;
  }
`;

const slideDown = keyframes`
  from {
    /* Prevent user interaction (like double-clicking buttons) while disappearing. */
    pointer-events: none;
  }
  to {
    transform: translateY(calc(100% + 10px + var(--actions-safe-area-bottom)));
  }
`;

const StyledActionContainer = styled.div`
  display: flex;
  flex-flow: column;
  position: relative;
  overflow: hidden;
  box-sizing: border-box;
  padding-top: calc(10px + ${safeArea.top()});
  padding-right: calc(10px + ${safeArea.right()});
  padding-bottom: calc(10px + ${safeArea.bottom()});
  padding-left: calc(10px + ${safeArea.left()});

  /* Our slide animations need the real bottom inset to clear the screen,
     but they run on our children, where we clear the safe area below. */
  --actions-safe-area-bottom: ${safeArea.bottom()};

  /* We render the backdrop as a separate div that we can animate
     opacity on, in hopes that webkit will optimize the animation in
     hardware. This would be as opposed to animating the parent background. */

  > .backdrop {
    z-index: 0;
    position: absolute;
    top: 0px;
    left: 0px;
    right: 0px;
    bottom: 0px;
    background: rgba(0, 0, 0, 0.5);
  }

  > .actions {
    /* We've padded the actions clear of every screen edge. */
    ${provideSafeArea(NO_SAFE_AREA)}
    z-index: 1;
    height: 0;
    flex-grow: 1;
    display: flex;
    flex-flow: column;
    align-items: center;
    justify-content: flex-end;
    pointer-events: none;

    > * {
      pointer-events: initial;
      max-height: 100%;
    }
  }

  &[data-animating-in="true"] {
    > .backdrop {
      animation: ${fadeIn} 0.3s linear backwards;
    }

    > .actions > * {
      animation: ${slideUp} 0.3s ${easing.outCubic} backwards;
      /* This makes the animation smoother as React has a chance to render the content first. */
      animation-delay: 150ms;
    }
  }

  &[data-animating-in="false"] {
    > .backdrop {
      animation: ${fadeOut} 0.3s linear forwards;
    }

    > .actions > * {
      animation: ${slideDown} 0.3s ${easing.outCubic} forwards;
    }
  }
`;
