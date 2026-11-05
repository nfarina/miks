import { describe, expect, test } from "vitest";
import { duoLaptopLayout, iPhonePortraitLayout } from "../mocks/layouts.js";
import { getKeyboardFold } from "./fold.js";

describe("getKeyboardFold", () => {
  // The laptop pose's fold band runs from 455.5 to 495.5.
  test("runs the page through the fold when the keyboard starts at it", () => {
    // Where the iPhone Duo's keyboard really starts.
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 455.5 })).toEqual({
      height: 495.5,
      bottom: 40,
    });
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 470 })).toEqual({
      height: 495.5,
      bottom: 40,
    });
  });

  test("keeps content out of the fold when the keyboard ends just below it", () => {
    expect(getKeyboardFold(duoLaptopLayout, { keyboardVisible: true, height: 497 })).toEqual({
      height: 497,
      bottom: 41.5,
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
