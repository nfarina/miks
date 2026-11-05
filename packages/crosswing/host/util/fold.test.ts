import { describe, expect, test } from "vitest";
import { duoLaptopLayout, iPhonePortraitLayout } from "../mocks/layouts.js";
import { extendThroughFold, getKeyboardFold } from "./fold.js";

describe("getKeyboardFold", () => {
  // The laptop pose's fold band runs from 455.5 to 495.5.
  // The window is 951 tall.
  test("runs the page behind the keyboard when the keyboard starts at the fold", () => {
    // Where the iPhone Duo's keyboard really starts.
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 455.5 })).toEqual({
      height: 951,
      bottom: 495.5,
    });
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 470 })).toEqual({
      height: 951,
      bottom: 495.5,
    });
  });

  test("keeps content out of the fold when the keyboard ends just below it", () => {
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 497 })).toEqual({
      height: 951,
      bottom: 495.5,
    });
  });

  test("leaves a keyboard that ends well clear of the fold alone", () => {
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 700 })).toBeNull();
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 300 })).toBeNull();
  });

  test("does nothing without a keyboard, or without a fold across the screen", () => {
    expect(getKeyboardFold(duoLaptopLayout, {})).toBeNull();
    expect(
      getKeyboardFold(iPhonePortraitLayout, { keyboardVisible: true, height: 497 }),
    ).toBeNull();
  });
});

describe("extendThroughFold", () => {
  const safeArea = { top: "0px", right: "0px", bottom: "0px", left: "0px" };
  const keyboard = { keyboardVisible: true, height: 600 };

  test("ends the page at the keyboard unless asked", () => {
    expect(extendThroughFold(safeArea, duoLaptopLayout, keyboard).viewport.height).toBe(600);
  });

  test("runs the page behind any keyboard when asked", () => {
    const { safeArea: inset, viewport } = extendThroughFold(safeArea, duoLaptopLayout, keyboard, {
      behindKeyboard: true,
    });
    expect(viewport.height).toBe(951);
    expect(inset.bottom).toBe("max(0px, 351px)");
  });
});
