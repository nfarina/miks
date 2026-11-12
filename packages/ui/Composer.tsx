import type { Terminal } from "@xterm/xterm";
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { styled } from "styled-components";

/** What the composer opens with: the shell's line (`captured`), or nothing. */
export type Composing = { text: string; cursor: number; captured: boolean };

/**
 * The composer (⌘E): the line you're typing as a plain text field, for
 * the Mac's own editing, selecting and newlines without backslashes. It
 * sits where the line was, in the terminal's font and cells, so the line
 * looks to have become editable in place, growing up over the scrollback
 * when it runs past the bottom, never resizing the terminal (a SIGWINCH).
 *
 * ⌘↩ runs it (pasted, so newlines stay in it, then Return); Escape puts it
 * back on the shell's line as it was, cursor and all, so opening it never
 * costs anything. From a shell at its prompt it takes what was typed
 * (`__miks_compose` in Miks's `.zshrc`); anywhere else (vim, ssh) it opens
 * empty, and what's written in it is pasted.
 */
export function Composer({
  terminal,
  composing,
  colors,
  onRun,
  onPutBack,
}: {
  terminal: Terminal;
  composing: Composing;
  colors: { background: string; foreground: string };
  onRun: (text: string) => void;
  onPutBack: (text: string, cursor: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(composing.text);
  const [lines, setLines] = useState(1);
  // Where the cursor is, again each time the terminal draws: output can
  // move the prompt (a background job printing), and so a resize.
  const [, redraw] = useState(0);
  useEffect(() => {
    const events = [terminal.onRender(() => redraw((n) => n + 1)), terminal.onResize(() => redraw((n) => n + 1))];
    return () => events.forEach((event) => event.dispose());
  }, [terminal]);

  useEffect(() => {
    const textarea = ref.current!;
    terminal.scrollToBottom();
    textarea.focus({ preventScroll: true });
    const at = offsetOf(composing.text, composing.cursor);
    textarea.setSelectionRange(at, at);
  }, []);

  const cell = cellSize(terminal);
  const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
  const buffer = terminal.buffer.active;
  const fullScreen = buffer.type === "alternate";

  // Lines as laid out (wrapping included), measured after each change.
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea || !cell) return;
    textarea.style.height = "0";
    setLines(Math.max(1, Math.round(textarea.scrollHeight / cell.height)));
    textarea.style.height = "";
  });

  if (!cell || !screen) return null;

  // On the cursor's row, from its column; in a full-screen program, along
  // the bottom. Past the bottom, it moves up, and the prompt's under it.
  const rows = terminal.rows;
  const shown = Math.min(lines, rows);
  const cursorRow = fullScreen ? rows - 1 : buffer.cursorY;
  const fits = !fullScreen && cursorRow + shown <= rows;
  const row = fits ? cursorRow : Math.max(0, rows - shown);
  const indent = fits ? buffer.cursorX * cell.width : 0;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    if (event.key === "Enter" && event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      onRun(textarea.value);
    } else if (event.key === "Escape" && !event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey) {
      event.preventDefault();
      onPutBack(textarea.value, charactersBefore(textarea.value, textarea.selectionStart));
    } else if (event.key === "Tab" && !event.metaKey && !event.altKey && !event.ctrlKey) {
      // A tab, not the next control: there's nothing to go to.
      event.preventDefault();
      document.execCommand("insertText", false, "\t");
    }
  }

  return (
    <StyledComposer
      style={{
        left: screen.offsetLeft,
        top: screen.offsetTop + row * cell.height,
        width: terminal.cols * cell.width,
        height: shown * cell.height,
        // The first line starts after the prompt, which stays in view.
        clipPath: indent
          ? `polygon(${indent}px 0, 100% 0, 100% 100%, 0 100%, 0 ${cell.height}px, ${indent}px ${cell.height}px)`
          : undefined,
        background: colors.background,
        color: colors.foreground,
      }}
    >
      <textarea
        ref={ref}
        className="composer"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        style={{
          fontFamily: terminal.options.fontFamily,
          fontSize: terminal.options.fontSize,
          lineHeight: `${cell.height}px`,
          letterSpacing: `${cell.width - characterWidth(terminal)}px`,
          textIndent: indent,
          color: colors.foreground,
          caretColor: colors.foreground,
        }}
      />
      {lines === 1 && indent / cell.width + text.length + HINT_ROOM < terminal.cols && (
        <div className="hint" style={{ fontSize: Math.max(10, (terminal.options.fontSize ?? 13) - 2) }}>
          ⌘↩ run · esc back to the shell
        </div>
      )}
    </StyledComposer>
  );
}

/** Cells the hint takes, kept clear of the text: it shows only while the line leaves them. */
const HINT_ROOM = 40;

/** A cell's size on screen, from xterm.js's renderer (no public way). */
function cellSize(terminal: Terminal): { width: number; height: number } | null {
  const cell = (terminal as any)._core?._renderService?.dimensions?.css?.cell;
  return cell?.width && cell?.height ? cell : null;
}

/** How wide a character of the terminal's font is drawn, for spacing the composer's to its cells. */
function characterWidth(terminal: Terminal): number {
  const context = (characterWidth.canvas ??= document.createElement("canvas")).getContext("2d");
  if (!context) return 0;
  context.font = `${terminal.options.fontSize}px ${terminal.options.fontFamily}`;
  return context.measureText("W").width;
}
characterWidth.canvas = null as HTMLCanvasElement | null;

/** zsh counts the cursor in characters; a string in UTF-16 units. */
const offsetOf = (text: string, characters: number) => Array.from(text).slice(0, characters).join("").length;
const charactersBefore = (text: string, offset: number) => Array.from(text.slice(0, offset)).length;
/** How many characters follow an offset, for moving the shell's cursor back to it. */
export const charactersAfter = (text: string, characters: number) => Array.from(text).length - characters;

const StyledComposer = styled.div`
  position: absolute;
  z-index: 5;
  overflow: hidden;

  > textarea {
    display: block;
    box-sizing: border-box;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    tab-size: 8;
    overflow-y: auto;
    scrollbar-width: none;
  }

  /* Tinted, so it reads as a field and not as the shell's own line. */
  &::before {
    content: "";
    position: absolute;
    inset: 0;
    background: currentColor;
    opacity: 0.06;
    pointer-events: none;
  }

  > .hint {
    position: absolute;
    right: 6px;
    bottom: 0;
    opacity: 0.4;
    pointer-events: none;
    font-family: system-ui;
  }
`;
