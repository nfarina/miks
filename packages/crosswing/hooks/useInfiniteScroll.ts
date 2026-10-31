import Debug from "debug";
import { DependencyList, UIEvent } from "react";
import { useResettableState } from "./useResettableState.js";

const debug = Debug("useInfiniteScroll");

/**
 * Manages auto-loading content as the user scrolls.
 *
 * @param loaded Number of items loaded so far.
 * @param options.pageSize The number of items to load for each "chunk".
 * @param options.minLimit Never ask for fewer items than this, like when jumping to something far back in the list.
 * @param deps Array of mixed values that causes us to reset our internal state.
 * @returns The number of items to load, and the onScroll listener to attach to your container.
 */
export function useInfiniteScroll(
  loaded: number,
  deps: DependencyList,
  { pageSize, minLimit = 0 }: { pageSize: number; minLimit?: number },
): [limit: number, onScroll: (e: UIEvent<any>) => void] {
  // Current limit. Reset the limit whenever our deps change.
  const [scrolledLimit, setLimit] = useResettableState<number>(pageSize, [...deps, pageSize]);
  const limit = Math.max(scrolledLimit, minLimit);

  // Last scroll Y value that triggered a load of an additional page. Reset
  // it when our deps change.
  const [currentLoadPoint, setCurrentLoadPoint] = useResettableState<number>(
    Number.NEGATIVE_INFINITY,
    deps,
  );

  // Scroll listener; the consumer must assign it to some scrolling element.
  function onScroll(e: UIEvent<any>) {
    // Sanity check - have we reached the end of the feed?
    if (loaded < limit) return;

    // Sanity check - have we even loaded the first page yet?
    if (!loaded) return;

    const scrollingContainer = e.target as HTMLElement;
    const { scrollTop, scrollHeight, offsetHeight } = scrollingContainer;

    // scrollTop point at which we should begin loading more data.
    const loadPoint = scrollHeight - offsetHeight * 3;

    // scrollTop can be negative if we're scrolling a flex container with
    // reversed layout. Math.abs fixes that.
    if (Math.abs(scrollTop) >= loadPoint && loadPoint > currentLoadPoint) {
      debug(`Set limit to ${limit + pageSize} items.`);
      setCurrentLoadPoint(loadPoint);
      setLimit(limit + pageSize);
    }
  }

  return [limit, onScroll];
}
