import type { Terminal } from "@xterm/xterm";
import { COARSE_POINTER_QUERY } from "crosswing/host/pointer";
import { useSyncExternalStore } from "react";
import { DEVICE_SETTINGS } from "./settings";

/**
 * Ctrl, from the bar: the next character typed into a terminal goes as its
 * control key (C as ⌃C). Tapped twice, it stays on until tapped again.
 */
let ctrl: "off" | "once" | "locked" = "off";
const ctrlListeners = new Set<() => void>();
export const setCtrl = (next: typeof ctrl) => {
  ctrl = next;
  for (const listener of ctrlListeners) listener();
};

/** What a terminal sends for what was typed, with Ctrl applied if it's on. */
export function withModifiers(data: string): string {
  if (ctrl === "off" || data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  // ⌃@ through ⌃_ (letters among them), ⌃Space as ⌃@, ⌃? as Delete.
  const control = code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data === " " ? "\x00" : data === "?" ? "\x7f" : null;
  if (control === null) return data;
  if (ctrl === "once") setCtrl("off");
  return control;
}

/** Whether Ctrl is on, for the bar's key. */
export function useCtrl() {
  return useSyncExternalStore(
    (listener) => {
      ctrlListeners.add(listener);
      return () => ctrlListeners.delete(listener);
    },
    () => ctrl,
  );
}

/** What keeps a terminal's textarea from being empty (`keepDeleteRepeating`). Never typed. */
const FILLER = "\u200b";

/** What a terminal sends for what's in its textarea, without the filler. */
export const withoutFiller = (data: string) => data.replaceAll(FILLER, "");

/**
 * Holding delete on an on-screen keyboard: xterm.js keeps its textarea empty,
 * and with no text to delete, iOS stops after the first. So on a touch screen
 * the textarea always has something in it, which is put back after xterm.js
 * clears it (on Return, ⌃C and blur). A delete that reaches the textarea
 * instead of being a key (which xterm.js sends, and which then never gets
 * here) goes as what it means, and leaves the filler where it is.
 */
export function keepDeleteRepeating(terminal: Terminal, send: (data: string) => void) {
  const textarea = terminal.textarea;
  if (!textarea || !DEVICE_SETTINGS || !matchMedia(COARSE_POINTER_QUERY).matches) return;

  const fill = () => {
    if (!textarea.value) textarea.value = FILLER;
  };
  fill();
  for (const type of ["focus", "keyup", "input"]) textarea.addEventListener(type, fill);
  textarea.addEventListener("beforeinput", (event) => {
    // ⌃W and ⌃U: iOS moves on to whole words, and lines, if delete is held.
    const data = { deleteContentBackward: "\x7f", deleteWordBackward: "\x17", deleteSoftLineBackward: "\x15", deleteHardLineBackward: "\x15" }[event.inputType];
    if (!data) return;
    event.preventDefault();
    send(data);
  });
}
