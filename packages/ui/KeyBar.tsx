import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { HostContext } from "crosswing/host/context";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, KeyboardOff } from "lucide-react";
import { type ReactNode, use, useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { setCtrl, useCtrl } from "./keys";
import { DEVICE_SETTINGS } from "./settings";
import { typeKey, type Key } from "./TerminalView";
import { hardwareKeyboard } from "./webBridge";

/**
 * The keys a touch screen's keyboard hasn't (Esc, ⌃C, Tab, ⇧Tab for Claude
 * Code's modes, Ctrl, arrows) and symbols it buries, just above it, while a
 * terminal has the keyboard. Not with a hardware keyboard, which has them.
 * ⌃C twice quits Claude Code, which says so after the first. At the end,
 * kept in view, a key to put the keyboard away: an iPad's has one, an
 * iPhone's hasn't.
 */
export function KeyBar() {
  const { viewport } = use(HostContext);
  const [terminalFocused, setTerminalFocused] = useState(false);
  const ctrlState = useCtrl();

  useEffect(() => {
    const update = () => setTerminalFocused(!!document.activeElement?.closest(".xterm"));
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
    };
  }, []);

  if (!DEVICE_SETTINGS || !viewport.keyboardVisible || !terminalFocused || hardwareKeyboard()) return null;

  return (
    <StyledKeyBar>
      <div className="keys">
        <KeyButton onPress={() => typeKey("escape")}>esc</KeyButton>
        <KeyButton onPress={() => typeKey("interrupt")}>⌃C</KeyButton>
        <KeyButton onPress={() => typeKey("tab")}>tab</KeyButton>
        <KeyButton onPress={() => typeKey("backtab")}>⇧tab</KeyButton>
        <KeyButton
          data-state={ctrlState}
          onPress={() => setCtrl(ctrlState === "off" ? "once" : ctrlState === "once" ? "locked" : "off")}
        >
          ctrl
        </KeyButton>
        <KeyButton repeats onPress={() => typeKey("left")}>
          <ArrowLeft />
        </KeyButton>
        <KeyButton repeats onPress={() => typeKey("up")}>
          <ArrowUp />
        </KeyButton>
        <KeyButton repeats onPress={() => typeKey("down")}>
          <ArrowDown />
        </KeyButton>
        <KeyButton repeats onPress={() => typeKey("right")}>
          <ArrowRight />
        </KeyButton>
        {["|", "~", "/", "-"].map((symbol) => (
          <KeyButton key={symbol} onPress={() => typeKey(symbol as Key)}>
            {symbol}
          </KeyButton>
        ))}
      </div>
      <KeyButton onRelease onPress={() => (document.activeElement as HTMLElement | null)?.blur()}>
        <KeyboardOff />
      </KeyButton>
    </StyledKeyBar>
  );
}

/**
 * A key that never takes focus from the terminal (or the keyboard would go
 * down), pressed as the finger lands; with `repeats`, again and again while
 * it's held, as a keyboard's do. With `onRelease`, as it lifts instead: for
 * one that hides the bar, which pressed on landing went from under the
 * finger, so the tap's click landed on the terminal and focused it again.
 */
function KeyButton({
  onPress,
  repeats,
  onRelease,
  children,
  ...rest
}: {
  onPress: () => void;
  repeats?: boolean;
  onRelease?: boolean;
  children: ReactNode;
  "data-state"?: string;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  useEffect(() => stop, []);

  return (
    <button
      type="button"
      tabIndex={-1}
      onPointerDown={(event) => {
        event.preventDefault();
        if (onRelease) return;
        onPress();
        if (!repeats) return;
        const again = (delay: number) => {
          timer.current = setTimeout(() => {
            onPress();
            again(60);
          }, delay);
        };
        again(400);
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onPointerLeave={stop}
      // The pointerdown did it; what follows a touch would take the focus.
      onMouseDown={(event) => event.preventDefault()}
      onTouchEnd={(event) => {
        event.preventDefault();
        if (onRelease) onPress();
      }}
      // A mouse's (or trackpad's): a touch's click never comes, its touchend prevented.
      onClick={() => onRelease && onPress()}
      {...rest}
    >
      {children}
    </button>
  );
}

const StyledKeyBar = styled.div`
  flex-shrink: 0;
  display: flex;
  border-top: 1px solid ${colors.separator()};
  background: ${colors.textBackgroundPanel()};

  > .keys {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 5px;
    padding: 6px 8px;
    overflow-x: auto;
    scrollbar-width: none;
  }

  > .keys > button,
  > button {
    flex-shrink: 0;
    min-width: 44px;
    height: 38px;
    padding: 0 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    border-radius: 8px;
    background: ${colors.textBackground()};
    color: ${colors.text()};
    box-shadow: 0 1px 0 ${colors.separator()};
    font: ${fonts.display({ size: 15 })};
    -webkit-user-select: none;
    user-select: none;
    touch-action: manipulation;

    > svg {
      width: 18px;
      height: 18px;
    }

    &:active {
      background: ${colors.buttonBackgroundGlow()};
    }

    &[data-state="once"] {
      background: ${colors.text()};
      color: ${colors.textBackground()};
    }

    &[data-state="locked"] {
      background: #5b4fd1;
      color: #fff;
    }
  }

  > button {
    margin: 6px 8px 6px 0;
  }
`;
