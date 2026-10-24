import type { Terminal } from "@xterm/xterm";

/**
 * Scrolling inside full-screen programs (Claude Code, vim, less) at the speed
 * the trackpad moves, the way Ghostty does it: one report per line's height
 * of scrolling. xterm.js sends at most one per wheel event, and scales
 * trackpad scrolling down to 0.3 besides, so a swipe there moves a few lines
 * where Ghostty moves dozens.
 *
 * Scrollback in the normal screen is left to xterm.js, which scrolls it
 * smoothly by the pixel.
 *
 * Returns what to call after `terminal.reset()`, which clears the encoding
 * without going through the parser.
 */
export function handleWheel(terminal: Terminal, send: (data: string) => void): { reset(): void } {
  // xterm.js keeps the mouse encoding to itself, so we watch for it too.
  let sgr = false;
  terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    if (params.includes(1006)) sgr = true;
    return false;
  });
  terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
    if (params.includes(1006)) sgr = false;
    return false;
  });
  terminal.parser.registerEscHandler({ final: "c" }, () => {
    sgr = false;
    return false;
  });

  // Fractions of a line carried over to the next event.
  let partial = 0;

  // Scrolls by `pixels` (down, positive) at a point on the screen; false if
  // it's xterm.js's own to scroll (the normal screen's scrollback).
  const scrollBy = (pixels: number, clientX: number, clientY: number, mode: number = WheelEvent.DOM_DELTA_PIXEL): boolean => {
    const tracking = terminal.modes.mouseTrackingMode !== "none";
    const alternate = terminal.buffer.active.type === "alternate";
    if (pixels === 0 || (!tracking && !alternate)) return false;

    const screen = terminal.element?.querySelector(".xterm-screen");
    if (!screen) return false;
    const rect = screen.getBoundingClientRect();
    const cellHeight = rect.height / terminal.rows;

    const lines =
      mode === WheelEvent.DOM_DELTA_LINE ? pixels : mode === WheelEvent.DOM_DELTA_PAGE ? pixels * terminal.rows : pixels / cellHeight;
    partial += lines;
    // A change of direction starts over, so the first line back isn't eaten.
    if (Math.sign(partial) !== Math.sign(lines)) partial = lines;

    const count = Math.min(Math.trunc(Math.abs(partial)), terminal.rows);
    partial -= Math.trunc(partial);
    if (count === 0) return true;

    const up = pixels < 0;
    let report: string;
    if (tracking) {
      const col = clamp(Math.floor((clientX - rect.left) / (rect.width / terminal.cols)) + 1, 1, terminal.cols);
      const row = clamp(Math.floor((clientY - rect.top) / cellHeight) + 1, 1, terminal.rows);
      // Wheel up and down are buttons 64 and 65.
      const button = up ? 64 : 65;
      report = sgr
        ? `\x1b[<${button};${col};${row}M`
        : `\x1b[M${String.fromCharCode(32 + button, 32 + Math.min(col, 223), 32 + Math.min(row, 223))}`;
    } else {
      // Without mouse reporting, a program on the alternate screen gets arrow
      // keys, as in xterm.js and Terminal.app.
      report = `\x1b${terminal.modes.applicationCursorKeysMode ? "O" : "["}${up ? "A" : "B"}`;
    }

    send(report.repeat(count));
    return true;
  };

  terminal.attachCustomWheelEventHandler((event) => {
    if (event.shiftKey) return true;
    return !scrollBy(event.deltaY, event.clientX, event.clientY, event.deltaMode);
  });

  // Two fingers on a touch screen scroll as a trackpad does: reports to a
  // full-screen program, or the normal screen's scrollback. One is a tap or
  // a selection.
  const element = terminal.element;
  let lastY: number | null = null;
  // As `partial`, for the scrollback.
  let touchPartial = 0;
  const middle = (touches: TouchList) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  });
  const onTouchStart = (event: TouchEvent) => {
    lastY = event.touches.length === 2 ? middle(event.touches).y : null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (event.touches.length !== 2 || lastY === null) return;
    event.preventDefault();
    const { x, y } = middle(event.touches);
    // Fingers going up move the content up: further down, as a trackpad's natural scrolling.
    const pixels = lastY - y;
    lastY = y;
    if (!scrollBy(pixels, x, y)) {
      const screen = terminal.element?.querySelector(".xterm-screen");
      const cellHeight = screen ? screen.getBoundingClientRect().height / terminal.rows : 16;
      touchPartial += pixels / cellHeight;
      const lines = Math.trunc(touchPartial);
      touchPartial -= lines;
      if (lines) terminal.scrollLines(lines);
    }
  };
  const onTouchEnd = (event: TouchEvent) => {
    if (event.touches.length < 2) lastY = null;
  };
  element?.addEventListener("touchstart", onTouchStart, { passive: true });
  element?.addEventListener("touchmove", onTouchMove, { passive: false });
  element?.addEventListener("touchend", onTouchEnd, { passive: true });
  element?.addEventListener("touchcancel", onTouchEnd, { passive: true });

  return { reset: () => (sgr = false) };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
