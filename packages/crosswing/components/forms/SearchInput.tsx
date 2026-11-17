import { Search } from "lucide-react";
import {
  ChangeEvent,
  InputHTMLAttributes,
  KeyboardEvent,
  Ref,
  use,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { fonts } from "../../fonts/fonts.js";
import { useHotKey } from "../../hooks/useHotKey.js";
import { HostContext } from "../../host/context/HostContext.js";
import { useScrollAboveKeyboard } from "../../host/features/useScrollAboveKeyboard.js";
import { CloseCircleIcon } from "../../icons/CloseCircle.js";
import { Spinner } from "../Spinner.js";

export type SearchInputRef = {
  focus(): void;
};

export function SearchInput({
  newStyle = false,
  placeholder = "Search",
  value,
  disabled,
  working,
  style,
  className,
  autoFocusOnDesktop,
  autoSelect,
  onValueChange,
  clearOnEscape = true,
  muted,
  pill,
  ref,
  ...rest
}: {
  newStyle?: boolean;
  placeholder?: string;
  value?: string;
  disabled?: boolean;
  working?: boolean;
  autoFocusOnDesktop?: boolean;
  /** When the input is auto-focused initially, any existing value will be selected. */
  autoSelect?: boolean;
  onValueChange?: (newValue: string, selectionStart: number | null) => void;
  clearOnEscape?: boolean;
  muted?: boolean;
  pill?: boolean;
  ref?: Ref<SearchInputRef>;
} & InputHTMLAttributes<HTMLInputElement>) {
  const { container } = use(HostContext);

  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    focus: () => {
      inputRef.current?.focus();
    },
  }));

  // Allow you to use the hotkey "/" to focus the search bar.
  useHotKey("/", { target: inputRef }, () => inputRef.current?.select());

  useScrollAboveKeyboard(inputRef);

  useLayoutEffect(() => {
    if (autoFocus && autoSelect && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  useEffect(() => {
    // This only makes sense on mobile where the keyboard gets in the way.
    if (container === "web") return;

    // Only a scroll you're dragging counts. The host scrolls a focused field
    // into view itself once the keyboard is up, and that mustn't blur it.
    let touching = false;
    const onTouchStart = () => (touching = true);
    const onTouchEnd = (e: TouchEvent) => (touching = e.touches.length > 0);

    const onScroll = (e: Event) => {
      const input = inputRef.current;
      if (!input || !touching) return;

      // If we're not focused, nothing to do.
      if (document.activeElement !== input) return;

      // First search the target's parents to make sure you didn't scroll
      // something inside the search bar itself.
      if (containsElement(input, e.target as Element)) return;

      // Must have scrolled something outside the input. Blur ourselves.
      input.blur();
    };

    // Begin listening for window-level touch move events so we can blur on
    // scrolling.
    window.addEventListener("scroll", onScroll, true); // useCapture = true
    window.addEventListener("touchstart", onTouchStart, true);
    window.addEventListener("touchend", onTouchEnd, true);
    window.addEventListener("touchcancel", onTouchEnd, true);

    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("touchstart", onTouchStart, true);
      window.removeEventListener("touchend", onTouchEnd, true);
      window.removeEventListener("touchcancel", onTouchEnd, true);
    };
  }, []);

  //
  // Handlers
  //

  function onInputChange(e: ChangeEvent<HTMLInputElement>) {
    onValueChange?.(e.currentTarget.value, e.currentTarget.selectionStart);
  }

  function onKeyUp(e: KeyboardEvent<HTMLInputElement>) {
    const input = inputRef.current;

    // Unfocus the input if you pressed enter, to get the keyboard out of
    // the way. This only makes sense on mobile.
    if (container !== "web" && e.key === "Enter") {
      input?.blur();
    }

    // If you pressed escape, clear the text.
    if (e.key === "Escape" && clearOnEscape) {
      if (value != null) {
        // Controlled component.
        onValueChange?.("", null);
      } else {
        // Uncontrolled component.
        if (input) input.value = "";
      }
    }
  }

  //
  // Render
  //

  const autoFocus = rest.autoFocus ?? (autoFocusOnDesktop && container === "web");

  // Separate any data- attributes from rest.
  const dataAttrs = {};
  const restAttrs = {};
  for (const key of Object.keys(rest)) {
    if (key.startsWith("data-")) {
      dataAttrs[key] = rest[key];
    } else {
      restAttrs[key] = rest[key];
    }
  }

  return (
    <StyledSearchInput
      style={style}
      className={className}
      data-new-style={newStyle}
      data-disabled={!!disabled}
      data-show-close={!!value}
      data-show-spinner={working}
      data-value-empty={!value}
      data-pill={!!pill}
      data-muted={!!muted}
      {...dataAttrs}
    >
      <input
        ref={inputRef}
        type="search"
        autoFocus={autoFocus}
        autoCorrect="off"
        autoCapitalize="off"
        autoComplete="off"
        placeholder={placeholder}
        onChange={onInputChange}
        onKeyUp={onKeyUp}
        value={value}
        disabled={disabled}
        {...restAttrs}
      />
      <div className="icon">
        <Search />
      </div>
      <div className="spinner">
        <Spinner smaller />
      </div>
      <div className="close" onClick={() => onValueChange?.("", null)}>
        <CloseCircleIcon />
      </div>
    </StyledSearchInput>
  );
}

export const StyledSearchInput = styled.div`
  display: flex;
  box-sizing: border-box;
  position: relative;

  > input {
    /* Remove intrinsic size and allow it to fit whatever container you put it in. */
    width: 0;
    flex-grow: 1;

    appearance: none;
    outline: none;
    display: block;
    box-sizing: border-box;
    font: ${fonts.display({ size: 16 })};
    color: ${colors.text()};
    border: none;
    border-radius: 0;
    padding: 0;
    background: transparent;

    &::-webkit-input-placeholder {
      color: ${colors.gray400()};
      font: inherit;

      @media (prefers-color-scheme: dark) {
        color: ${colors.gray450()};
      }
    }

    &::-webkit-search-cancel-button {
      display: none;
    }

    &:disabled {
      color: ${colors.text({ alpha: 0.5 })};

      @media (prefers-color-scheme: dark) {
        color: ${colors.text({ alpha: 0.5 })};
      }
    }

    transition: color 0.2s ease-in-out;
  }

  > .icon {
    display: flex;
    align-items: center;
    justify-content: center;
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    color: ${colors.gray450()};
    pointer-events: none;

    @media (prefers-color-scheme: dark) {
      color: ${colors.gray400()};
    }

    > svg {
      width: 18px;
      height: 18px;
    }
  }

  > .spinner {
    position: absolute;
    top: 0px;
    right: 35px;
    bottom: 0px;
    align-items: center;
    justify-content: center;
    display: none;
  }

  > .close {
    position: absolute;
    top: 0px;
    right: 0px;
    bottom: 0px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 8px 0 8px;
    visibility: hidden;
    cursor: pointer;
    color: ${colors.gray450()};

    svg {
      width: 18px;
      height: 18px;
    }

    @media (hover: hover) and (pointer: fine) {
      &:hover {
        color: ${colors.black()};
      }
    }

    @media (prefers-color-scheme: dark) {
      color: ${colors.gray300()};

      @media (hover: hover) and (pointer: fine) {
        &:hover {
          color: ${colors.white()};
        }
      }
    }
  }

  &[data-disabled="true"] {
    > .icon {
      opacity: 0.5;
    }

    > .close {
      opacity: 0.5;
      pointer-events: none;
    }
  }

  &[data-show-spinner="true"] {
    > input {
      padding-right: 65px;
    }

    > .spinner {
      display: flex;
    }
  }

  &[data-show-close="true"] {
    > .close {
      visibility: visible;
    }
  }

  /* Legacy styling (newStyle=false) */
  &[data-new-style="false"] {
    height: 34px;

    > input {
      background: ${colors.textBackground()};
      font: ${fonts.display({ size: 16 })};
      border: 1px solid ${colors.separator()};
      border-radius: 3px;
      padding: 9px 30px 8px 30px;

      &::-webkit-input-placeholder {
        color: ${colors.gray300()};

        @media (prefers-color-scheme: dark) {
          color: ${colors.gray400()};
        }
      }
    }

    > .icon {
      left: 11px;
      color: ${colors.gray300()};

      @media (prefers-color-scheme: dark) {
        color: ${colors.gray400()};
      }

      > svg {
        width: 16px;
        height: 16px;
      }
    }
  }

  /* Modern styling (newStyle=true) */
  &[data-new-style="true"] {
    border: 1px solid ${colors.controlBorder()};
    border-radius: 9px;
    min-height: 40px;

    > input {
      font: ${fonts.display({ size: 14, line: "18px" })};
      padding: 8px 35px 8px 35px;
    }

    > .icon {
      left: 10px;
    }

    &[data-pill="true"] {
      border-radius: 9999px;

      > input {
        padding-right: 40px;
        /* For outline. */
        border-radius: 9999px;
      }

      > .close {
        right: 5px;
      }
    }

    &[data-muted="true"] {
      border: none;
      background: ${colors.gray500({ alpha: 0.1 })};

      @media (prefers-color-scheme: dark) {
        background: ${colors.gray550({ alpha: 0.2 })};
      }
    }
  }
`;

function containsElement(parent: Element, child: Element | null): boolean {
  if (!child) return false; // no more parents
  if (child === parent) return true;
  return containsElement(parent, child.parentElement);
}
