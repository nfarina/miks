import { describe, expect, test } from "vitest";
import { duoLaptopLayout, iPhonePortraitLayout } from "../mocks/layouts.js";
import { getFoldAboveKeyboard } from "./fold.js";

describe("getFoldAboveKeyboard", () => {
  // The laptop pose's fold band runs from 455.5 to 495.5.
  test("keeps content out of the fold when the keyboard ends in it", () => {
    expect(getFoldAboveKeyboard(duoLaptopLayout, { keyboardVisible: true, height: 497 })).toBe(
      41.5,
    );
  });

  test("leaves a keyboard that ends well clear of the fold alone", () => {
    expect(getFoldAboveKeyboard(duoLaptopLayout, { keyboardVisible: true, height: 700 })).toBe(0);
    expect(getFoldAboveKeyboard(duoLaptopLayout, { keyboardVisible: true, height: 300 })).toBe(0);
  });

  test("does nothing without a keyboard, or without a fold across the screen", () => {
    expect(getFoldAboveKeyboard(duoLaptopLayout, {})).toBe(0);
    expect(getFoldAboveKeyboard(iPhonePortraitLayout, { keyboardVisible: true, height: 497 })).toBe(
      0,
    );
  });
});
