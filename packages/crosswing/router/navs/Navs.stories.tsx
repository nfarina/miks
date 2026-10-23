import { Meta, StoryObj } from "@storybook/react";
import { use } from "react";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { colors } from "../../colors/colors.js";
import { MockHostProvider } from "../../host/mocks/MockHostProvider.js";
import { CrosswingAppDecorator } from "../../storybook.js";
import { Link } from "../Link.js";
import { RouterContext } from "../context/RouterContext.js";
import { Redirect } from "../redirect/Redirect.js";
import { BrowserSimulator } from "../storybook/BrowserSimulator.js";
import { styled } from "styled-components";
import { Scrollable } from "../../components/Scrollable.js";
import { SeparatorLayout, StyledSeparatorLayout } from "../../components/SeparatorLayout.js";
import { TextCell } from "../../components/forms/TextCell.js";
import { padSafeArea } from "../../safearea/safeArea.js";
import { NavLayout, NavRoute, Navs } from "./Navs.js";

export default {
  component: Navs,
  decorators: [CrosswingAppDecorator({ layout: "mobile" })],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Navs>;

function BookPage({ bookId }: { bookId: string }) {
  return (
    <div className="page">
      <h1>BOOK {bookId}</h1>
      <Link to={`/books/${bookId}/imports/imp1`}>Start import</Link>
    </div>
  );
}

// Stands in for RecipeImportPage once an import has finished: it hops straight
// to the new recipe, replacing itself in history (replace: true).
function ImportPage({ bookId }: { bookId: string }) {
  return <Redirect to={`/books/${bookId}/recipes/rec1`} />;
}

function RecipePage({ bookId, recipeId }: { bookId: string; recipeId: string }) {
  const { back, history } = use(RouterContext);
  return (
    <div className="page">
      <h1>RECIPE {recipeId}</h1>
      {/* The Navs-computed back target — the heart of the regression. */}
      <div>back: {back ?? "(none)"}</div>
      <button onClick={() => back && history.navigate(back)}>Back</button>
    </div>
  );
}

function RecipeNavs() {
  return (
    <BrowserSimulator initialPath="/books/bookA">
      <Navs>
        <NavRoute render={() => <div className="page">HOME</div>} />
        <NavRoute path="books/:bookId" render={({ bookId }) => <BookPage bookId={bookId} />} />
        <NavRoute
          path="books/:bookId/imports/:importId"
          render={({ bookId }) => <ImportPage bookId={bookId} />}
        />
        <NavRoute
          path="books/:bookId/recipes/:recipeId"
          render={({ bookId, recipeId }) => <RecipePage bookId={bookId} recipeId={recipeId} />}
        />
      </Navs>
    </BrowserSimulator>
  );
}

/**
 * Reproduces the recipe-import bug: landing on the import page, which redirects
 * (replace) to the finished recipe. A replace must swap the import page out of
 * the back stack rather than push the recipe on top of it — otherwise the back
 * button bounces import→recipe forever and a stale top item eats taps.
 */
export const RedirectReplacesImportInStack: StoryObj<typeof Navs> = {
  render: () => <RecipeNavs />,
  play: async ({ canvasElement, step }) => {
    const canvas = within(canvasElement);

    await step("start on the book", async () => {
      await expect(await canvas.findByText("BOOK bookA")).toBeVisible();
    });

    await step("start an import; it completes and redirects to the recipe", async () => {
      await userEvent.click(await canvas.findByText("Start import"));
      await expect(await canvas.findByText("RECIPE rec1")).toBeVisible();
    });

    await step("back skips the replaced import page and points at the book", async () => {
      // The fix: /books/bookA. Pre-fix this read /books/bookA/imports/imp1.
      await expect(await canvas.findByText("back: /books/bookA")).toBeInTheDocument();
    });

    await step("pressing back lands on the book (no import→recipe bounce)", async () => {
      await userEvent.click(await canvas.findByRole("button", { name: "Back" }));
      // The recipe is popped off the stack rather than re-pushed by a bounce.
      // It lingers for the exit animation, so wait for it to leave; a bounce
      // would keep it mounted.
      await waitFor(() => expect(canvas.queryByText("RECIPE rec1")).not.toBeInTheDocument());
      await expect(await canvas.findByText("BOOK bookA")).toBeVisible();
    });
  },
};

function SettingsPage({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <NavLayout isApplicationRoot={title === "Settings"} title={title} extendsUnderBars>
      <Scrollable>
        <StyledSettingsPage>
          <SeparatorLayout bordered>
            {links.map(([label, to]) => (
              <TextCell key={to} newStyle to={to} title={label} />
            ))}
          </SeparatorLayout>
        </StyledSettingsPage>
      </Scrollable>
    </NavLayout>
  );
}

const StyledSettingsPage = styled.div`
  ${padSafeArea("left", "right", "top", { bottom: "20px" })}

  > ${StyledSeparatorLayout} {
    margin: 20px 10px;
  }
`;

/**
 * Split <Navs>, like Settings. With room (an iPad, or an iPhone Duo open or
 * in the book pose), the root stays on the left and what it opens stacks up
 * on the right; opening another of the root's pages starts that stack over.
 * About is a full-screen route, so the root's pane steps aside for it.
 * Anywhere narrower, it's an ordinary stack.
 */
export const Split: StoryObj<typeof Navs> = {
  render: () => (
    <BrowserSimulator initialPath="/">
      <Navs split>
        <NavRoute
          render={() => (
            <SettingsPage
              title="Settings"
              links={[
                ["General", "/general"],
                ["Privacy", "/privacy"],
              ]}
            />
          )}
        />
        <NavRoute
          path="general"
          render={() => <SettingsPage title="General" links={[["About", "/general/about"]]} />}
        />
        <NavRoute
          path="general/about"
          fullScreen
          render={() => <SettingsPage title="About" links={[]} />}
        />
        <NavRoute path="privacy" render={() => <SettingsPage title="Privacy" links={[]} />} />
      </Navs>
    </BrowserSimulator>
  ),
};

/**
 * Swipe right anywhere on the book page to go back home (as on iOS): the page
 * follows the finger, then slides away or settles back when let go. Then
 * swipe left to go forward to it again.
 */
export const SwipeBack: StoryObj<typeof Navs> = {
  render: () => (
    <MockHostProvider inherit container="ios">
      <BrowserSimulator initialPath="/books/bookA">
        <Navs>
          <NavRoute render={() => <SwipePage title="Home" link="/books/bookA" />} />
          <NavRoute
            path="books/:bookId"
            render={({ bookId }) => <SwipePage title={`Book ${bookId}`} />}
          />
        </Navs>
      </BrowserSimulator>
    </MockHostProvider>
  ),
};

function SwipePage({ title, link }: { title: string; link?: string }) {
  return (
    <NavLayout title={title} style={{ background: colors.textBackground() }}>
      <Scrollable>
        <div>
          {link && (
            <div style={{ padding: "12px 16px" }}>
              <Link to={link}>Open book</Link>
            </div>
          )}
          {Array.from({ length: 30 }, (_, i) => (
            <div key={i} style={{ padding: "12px 16px" }}>
              {title}, row {i + 1}
            </div>
          ))}
        </div>
      </Scrollable>
    </NavLayout>
  );
}
