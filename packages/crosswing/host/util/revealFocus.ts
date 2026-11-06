import { RefObject, useEffect, useRef } from "react";
import { HostViewport } from "./types.js";

/**
 * Keeps the focused text field above the keyboard, for a page behind it
 * (HostProvider's `behindKeyboard`). Ending the page at the keyboard let
 * WebKit scroll a field into view itself; behind it, the page doesn't shrink
 * and the web view's own scroller is held still, so a field could sit under
 * the keyboard while you typed into it. Here the field's scrollers scroll it
 * up with the keyboard, frame by frame, as far as its top stays in view, and
 * again as it grows. A scroller that runs behind the keyboard without padding
 * for it (most don't, and needn't) is given just enough room once the
 * keyboard's up (see makeRoom).
 */
export function useRevealFocus(
  host: RefObject<HTMLElement | null>,
  viewport: HostViewport,
  enabled: boolean,
) {
  const visible = enabled && !!viewport.keyboardVisible;
  const duration = (viewport.duration ?? 0.25) * 1000;

  // For the listeners, which outlive a render.
  const state = useRef({ visible, duration });
  state.current = { visible, duration };

  // The keyboard came, went, or changed height.
  useEffect(() => {
    if (!enabled) return;

    if (visible) {
      const field = focusedField();
      if (!field) return;

      // With the keyboard, then, once it's up, again with any room made.
      let stop = follow(host, field, duration, () => {
        if (makeRoom(host.current, field)) stop = follow(host, field, 250);
      });
      return () => stop();
    }

    // Once the keyboard's down, its inset is 0 and the padding nothing.
    const timeout = setTimeout(removeRoom, duration + 150);
    return () => clearTimeout(timeout);
  }, [enabled, viewport]);

  // A field focused, or typed into, while the keyboard is already up.
  useEffect(() => {
    if (!enabled) return;

    let stop: (() => void) | undefined;

    function onFocusIn(e: FocusEvent) {
      if (!state.current.visible || !isTextField(e.target)) return;
      makeRoom(host.current, e.target);
      stop?.();
      stop = follow(host, e.target, 250);
    }

    function onInput(e: Event) {
      if (!state.current.visible || !isTextField(e.target)) return;
      reveal(host.current, e.target, 1);
    }

    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("input", onInput);
    return () => {
      stop?.();
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("input", onInput);
    };
  }, [enabled]);
}

/** Space between a field and the keyboard's top. */
const MARGIN = 16;

/** Each frame, how much of the rest of the way a field moves. */
const EASE = 0.35;

/** Scrollers given room, with the inline bottom padding they had. */
const padded = new Map<HTMLElement, string>();

/**
 * Reveals the field every frame for as long as the keyboard moves, so it
 * rises with it, then stops, leaving the scroller to whoever scrolls it.
 */
function follow(
  host: RefObject<HTMLElement | null>,
  field: HTMLElement,
  duration: number,
  then?: () => void,
) {
  const end = performance.now() + duration + 100;
  let frame = requestAnimationFrame(function step(now) {
    reveal(host.current, field, EASE);
    if (now < end) frame = requestAnimationFrame(step);
    else then?.();
  });
  return () => cancelAnimationFrame(frame);
}

/**
 * Scrolls the field's scrollers, nearest first, until it's above the
 * keyboard as it is this frame (the bottom safe area, which moves with it),
 * taking `ease` of the way there.
 */
function reveal(hostElement: HTMLElement | null, field: HTMLElement, ease: number) {
  if (!hostElement || !field.isConnected) return;

  const keyboardTop = getKeyboardTop(hostElement);
  const shown = getShown(field, keyboardTop);
  let behind = shown.bottom + MARGIN - keyboardTop;
  if (behind < 0.5) return;
  behind = behind * ease < 1 ? behind : behind * ease;

  // Where what's shown sits from the field's top, as the field moves.
  const offset = shown.top - field.getBoundingClientRect().top;

  for (let scroller = scrollerOf(field); scroller && behind >= 0.5; scroller = scrollerOf(scroller)) {
    // No further than would take its top out of this scroller.
    const top = field.getBoundingClientRect().top + offset;
    const room = top - MARGIN - scroller.getBoundingClientRect().top;
    const by = Math.min(behind, room);
    if (by < 0.5) break;

    const before = scroller.scrollTop;
    scroller.scrollTop = before + by;
    behind -= scroller.scrollTop - before;
  }
}

/** The top of the keyboard this frame, in the viewport. */
function getKeyboardTop(hostElement: HTMLElement): number {
  const inset = parseFloat(getComputedStyle(hostElement).getPropertyValue("--safe-area-bottom")) || 0;
  return hostElement.getBoundingClientRect().bottom - inset;
}

/**
 * What of the field to keep above the keyboard, in the viewport: all of it
 * when it fits above the keyboard in its scroller, and otherwise the line
 * with the caret, for a long textarea or editable text.
 */
function getShown(field: HTMLElement, keyboardTop: number): { top: number; bottom: number } {
  const rect = field.getBoundingClientRect();
  const scroller = scrollerOf(field);
  const space = keyboardTop - (scroller?.getBoundingClientRect().top ?? 0) - 2 * MARGIN;
  if (rect.height <= space) return rect;
  return getCaret(field) ?? rect;
}

/** The caret's line in a textarea or editable text, in the viewport. */
function getCaret(field: HTMLElement): { top: number; bottom: number } | null {
  if (field instanceof HTMLTextAreaElement) {
    const line = getTextareaCaret(field);
    const top = field.getBoundingClientRect().top + line.top - field.scrollTop;
    return { top, bottom: top + line.height };
  }

  const selection = field.isContentEditable ? document.getSelection() : null;
  if (!selection?.rangeCount || !field.contains(selection.focusNode)) return null;
  const range = document.createRange();
  range.setStart(selection.focusNode!, selection.focusOffset);
  const rects = range.getClientRects();
  // A caret on an empty line has no rects; the line's element does.
  const rect = rects[rects.length - 1] ??
    (selection.focusNode instanceof Element ? selection.focusNode.getBoundingClientRect() : null);
  return rect && rect.height > 0 ? rect : null;
}

/**
 * Where a textarea's caret line is from its top, which it doesn't say:
 * measured on a hidden copy styled like it, with its text up to the caret.
 * Remembered until the text, caret, or width changes, since the keyboard's
 * frames ask again and again.
 */
function getTextareaCaret(area: HTMLTextAreaElement): { top: number; height: number } {
  const end = area.selectionEnd ?? area.value.length;
  const key = `${area.clientWidth}:${end}:${area.value}`;
  if (caretCache?.area === area && caretCache.key === key) return caretCache.line;

  const style = getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const property of MIRRORED) mirror.style[property] = style[property];
  Object.assign(mirror.style, {
    position: "absolute",
    top: "0",
    left: "-10000px",
    visibility: "hidden",
    height: "auto",
    overflow: "hidden",
    whiteSpace: "pre-wrap",
  });
  mirror.textContent = area.value.slice(0, end);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const line = { top: marker.offsetTop, height: marker.offsetHeight };
  mirror.remove();

  caretCache = { area, key, line };
  return line;
}

let caretCache: { area: HTMLTextAreaElement; key: string; line: { top: number; height: number } } | null =
  null;

/** What lays out a textarea's text, for getTextareaCaret's copy. */
const MIRRORED = [
  "boxSizing",
  "width",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontStretch",
  "fontVariant",
  "letterSpacing",
  "lineHeight",
  "textIndent",
  "textTransform",
  "tabSize",
  "wordSpacing",
  "wordBreak",
  "overflowWrap",
] as const;

/**
 * Pads the field's scroller so there's enough to scroll for the field to
 * clear the keyboard, only when it needs it: when, with the keyboard up, the
 * field is behind it, the scroller hasn't enough left to scroll, and its own
 * bottom runs behind the keyboard too (a sheet that rises with the keyboard
 * doesn't). Only by as much as the keyboard covers it, shrinking as the
 * keyboard goes (`--keyboard-inset`); and not at all where the padding would
 * grow the scroller, as for one sized by its content. Says whether it did.
 */
function makeRoom(hostElement: HTMLElement | null, field: HTMLElement): boolean {
  const scroller = scrollerOf(field);
  if (!hostElement || !scroller || padded.has(scroller)) return false;

  const host = getComputedStyle(hostElement);
  const keyboardTop = getKeyboardTop(hostElement);
  const behind = getShown(field, keyboardTop).bottom + MARGIN - keyboardTop;
  const left = scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop;
  if (behind < 0.5 || left >= behind) return false;

  const before = scroller.getBoundingClientRect();
  const covered = before.bottom - keyboardTop;
  if (covered < 1) return false;

  // The keyboard covers it by `covered` now, and by nothing once it's gone.
  const inset = parseFloat(host.getPropertyValue("--keyboard-inset")) || 0;
  const padding = getComputedStyle(scroller).paddingBottom;
  padded.set(scroller, scroller.style.paddingBottom);
  scroller.style.paddingBottom = `calc(${padding} + max(0px, var(--keyboard-inset, 0px) - ${inset - covered}px))`;

  if (Math.abs(scroller.getBoundingClientRect().height - before.height) > 0.5) {
    scroller.style.paddingBottom = padded.get(scroller)!;
    padded.delete(scroller);
    return false;
  }
  return true;
}

function removeRoom() {
  for (const [scroller, padding] of padded) scroller.style.paddingBottom = padding;
  padded.clear();
}

/** The nearest ancestor that scrolls vertically, below the page itself. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    if (parent === document.body || parent === document.documentElement) return null;
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") return parent;
  }
  return null;
}

function focusedField(): HTMLElement | null {
  const focused = document.activeElement;
  return isTextField(focused) ? focused : null;
}

/** Whether the keyboard comes up for it. */
function isTextField(target: EventTarget | null): target is HTMLElement {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly;
  if (target instanceof HTMLInputElement) return !target.readOnly && !NOT_TEXT.has(target.type);
  return target instanceof HTMLElement && target.isContentEditable;
}

const NOT_TEXT = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);
