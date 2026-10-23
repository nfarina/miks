import { describe, expect, test } from "vitest";
import { getSwipeFinish } from "./useSwipe.js";

/** The speed (px/ms) a finish starts at: its curve's first slope, in pixels. */
function startingSpeed(distance: number, { duration, easing }: { duration: number; easing: string }) {
  const [x1, y1] = easing.match(/[\d.]+/g)!.map(Number);
  return (y1 / x1) * (distance / duration);
}

describe("getSwipeFinish", () => {
  test("starts at the speed it was let go", () => {
    const finish = getSwipeFinish(400, 2);
    expect(startingSpeed(400, finish)).toBeCloseTo(2, 2);
  });

  test("a harder flick finishes sooner", () => {
    expect(getSwipeFinish(400, 4).duration).toBeLessThan(getSwipeFinish(400, 2).duration);
  });

  test("a slow release takes its time, but not forever", () => {
    expect(getSwipeFinish(400, 0.1).duration).toBe(600);
    expect(getSwipeFinish(400, 0).duration).toBe(600);
  });

  test("a very hard flick still takes a moment", () => {
    expect(getSwipeFinish(100, 20).duration).toBe(150);
  });
});
