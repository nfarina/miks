import { describe, expect, test } from "vitest";
import { decideSwipe, getSwipeFinish } from "./useSwipe.js";

/** The speed (px/ms) a finish starts at: its curve's first slope, in pixels. */
function startingSpeed(
  distance: number,
  { duration, easing }: { duration: number; easing: string },
) {
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

describe("decideSwipe", () => {
  const edge = { atEdge: true, canPullBack: false };

  test("waits until the finger has moved a few pixels, so a wobbly tap stays a tap", () => {
    expect(decideSwipe({ along: 2, across: 0, ...edge })).toBe("undecided");
    expect(decideSwipe({ along: 3, across: 3, ...edge })).toBe("undecided");
  });

  test("a clear drag its way is a swipe", () => {
    expect(decideSwipe({ along: 12, across: 3, ...edge })).toBe("swipe");
  });

  test("a scroll that drifts sideways stays a scroll", () => {
    expect(decideSwipe({ along: 5, across: 8, ...edge })).toBe("ignore");
    expect(decideSwipe({ along: 8, across: 5, ...edge })).toBe("ignore");
  });

  test("not while what's under the finger can still scroll that way", () => {
    expect(decideSwipe({ along: 12, across: 0, atEdge: false, canPullBack: false })).toBe("ignore");
  });

  test("backward only with overscroll", () => {
    expect(decideSwipe({ along: -12, across: 0, ...edge })).toBe("ignore");
    expect(decideSwipe({ along: -12, across: 0, atEdge: true, canPullBack: true })).toBe("swipe");
  });
});
