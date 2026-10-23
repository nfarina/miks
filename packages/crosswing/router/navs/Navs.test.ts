import { describe, expect, test } from "vitest";
import { RouterLocation } from "../RouterLocation.js";
import { getForwardLocations, pushLocation } from "./Navs.js";

// Render the resulting stack as plain hrefs for easy assertions.
function hrefs(locations: RouterLocation[]): string[] {
  return locations.map((l) => l.href());
}

const root = RouterLocation.fromHref("/recipes");
const book = RouterLocation.fromHref("/recipes/books/X");
const importPage = RouterLocation.fromHref("/recipes/books/X/imports/Y");
const recipe = RouterLocation.fromHref("/recipes/books/X/recipes/Y2");

describe("pushLocation", () => {
  test("pushes a new location onto the stack", () => {
    const result = pushLocation(root, [root, book], importPage);
    expect(hrefs(result)).toEqual(["/recipes", "/recipes/books/X", "/recipes/books/X/imports/Y"]);
  });

  test("navigating to the penultimate location pops (back)", () => {
    const result = pushLocation(root, [root, book, importPage], book);
    expect(hrefs(result)).toEqual(["/recipes", "/recipes/books/X"]);
  });

  test("navigating to the same top location replaces it (e.g. search change)", () => {
    const bookSorted = RouterLocation.fromHref("/recipes/books/X?sort=name");
    const result = pushLocation(root, [root, book], bookSorted);
    expect(hrefs(result)).toEqual(["/recipes", "/recipes/books/X?sort=name"]);
  });

  // The core fix: a replace navigation (e.g. <Redirect> from a finished import
  // page to the resulting recipe) must swap the top of the stack rather than
  // push, so the import page leaves the back stack instead of lingering beneath
  // the recipe (which broke the back button and stranded a tap-eating layer).
  test("replace swaps the top entry instead of pushing", () => {
    const result = pushLocation(root, [root, book, importPage], recipe, true);
    expect(hrefs(result)).toEqual(["/recipes", "/recipes/books/X", "/recipes/books/X/recipes/Y2"]);
    // Back from the recipe now goes to the book, not the dead import page.
    expect(result[result.length - 2].href()).toEqual("/recipes/books/X");
  });

  test("replace is idempotent across re-renders once recorded", () => {
    // After the replace above is stored, re-rendering with the same (still
    // replace-flagged) location must not keep mutating the stack.
    const once = pushLocation(root, [root, book, importPage], recipe, true);
    const twice = pushLocation(root, once, recipe, true);
    expect(hrefs(twice)).toEqual(hrefs(once));
  });

  test("replace never pops the root, so there's always a way back", () => {
    const result = pushLocation(root, [root], book, true);
    expect(hrefs(result)).toEqual(["/recipes", "/recipes/books/X"]);
  });
});

describe("getForwardLocations", () => {
  test("going back saves the page you left", () => {
    const result = getForwardLocations([root, book, recipe], [root, book], []);
    expect(hrefs(result)).toEqual(["/recipes/books/X/recipes/Y2"]);
  });

  test("going back again stacks them, latest last", () => {
    const result = getForwardLocations([root, book], [root], [recipe]);
    expect(hrefs(result)).toEqual(["/recipes/books/X/recipes/Y2", "/recipes/books/X"]);
  });

  test("going forward spends the latest", () => {
    const result = getForwardLocations([root], [root, book], [recipe, book]);
    expect(hrefs(result)).toEqual(["/recipes/books/X/recipes/Y2"]);
  });

  test("going anywhere else forgets them", () => {
    const result = getForwardLocations([root, book], [root, book, importPage], [recipe]);
    expect(result).toEqual([]);
  });

  test("the same page with a new search keeps them", () => {
    const bookSorted = RouterLocation.fromHref("/recipes/books/X?sort=name");
    const result = getForwardLocations([root, book], [root, bookSorted], [recipe]);
    expect(hrefs(result)).toEqual(["/recipes/books/X/recipes/Y2"]);
  });
});
