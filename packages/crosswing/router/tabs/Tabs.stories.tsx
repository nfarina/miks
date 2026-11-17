import { StoryObj } from "@storybook/react";
import { BookOpen, Ellipsis, ListChecks, MessageCircle, Pencil, Search, User } from "lucide-react";
import { action } from "storybook/actions";
import { useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { colors } from "../../colors/colors.js";
import { Scrollable, StyledScrollable } from "../../components/Scrollable.js";
import { fonts } from "../../fonts/fonts.js";
import { DeviceSimulator } from "../../host/mocks/DeviceSimulator.js";
import { iPhonePortraitLayout } from "../../host/mocks/layouts.js";
import { MockDevice } from "../../host/mocks/MockDevice.js";
import {
  overlaySafeArea,
  padSafeArea,
  safeArea,
  safeAreaResting,
} from "../../safearea/safeArea.js";
import { CrosswingAppDecorator } from "../../storybook.js";
import { Router } from "../Router.js";
import { MemoryHistory } from "../history/MemoryHistory.js";
import { Link } from "../Link.js";
import { NavLayout } from "../navs/NavLayout.js";
import { NavRoute, Navs } from "../navs/Navs.js";
import { Tab, Tabs } from "./Tabs.js";

export default {
  component: Tabs,
};

export const Normal: StoryObj = {
  render: () => <NormalTabs />,
  decorators: [CrosswingAppDecorator({ layout: "mobile" })],
  parameters: { layout: "centered" },
};

function NormalTabs() {
  const [history] = useState(() => new MemoryHistory());

  return (
    <Router
      history={history}
      render={() => (
        <Tabs>
          <Tab path="home" title="Home" render={() => <SamplePage>Favorite Cupcakes</SamplePage>} />
          <Tab
            path="activity"
            title="Activity"
            render={() => <SamplePage>List of Cupcake Tastings</SamplePage>}
          />
          <Tab
            path="account"
            title="Account"
            render={() => <SamplePage>Cupcake Account</SamplePage>}
          />
        </Tabs>
      )}
    />
  );
}

const SamplePage = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  font: ${fonts.display({ size: 14 })};
  color: ${colors.text()};
`;

/** Pick a device and pose from the toolbar to see each tab bar presentation. */
export const Simulator: StoryObj = {
  render: () => <SimulatedTabs />,
  decorators: [CrosswingAppDecorator({ layout: "fullscreen" })],
  parameters: { layout: "fullscreen" },
};

function SimulatedTabs() {
  const [history] = useState(() => new MemoryHistory());

  return (
    <DeviceSimulator>
      <Router
        history={history}
        render={() => (
          <Tabs>
            <Tab
              path="recipes"
              title="Recipes"
              icon={<BookOpen size={22} />}
              render={() => <ListNavs title="Recipes" />}
            />
            <Tab
              path="chats"
              title="Chats"
              icon={<MessageCircle size={22} />}
              badge={3}
              render={() => <ListNavs title="Chats" />}
            />
            <Tab
              path="search"
              title="Search"
              icon={<Search size={22} />}
              render={() => <ListNavs title="Search" />}
            />
            <Tab
              path="lists"
              title="List"
              icon={<ListChecks size={22} />}
              render={() => <ListNavs title="List" />}
            />
            <Tab
              path="account"
              title="Account"
              icon={<User size={22} />}
              render={() => <ListNavs title="Account" />}
            />
          </Tabs>
        )}
      />
    </DeviceSimulator>
  );
}

function ListNavs({ title }: { title: string }) {
  return (
    <Navs>
      <NavRoute render={() => <ListPage title={title} />} />
      <NavRoute path=":row" render={({ row }) => <DetailPage title={`${title} row ${row}`} />} />
    </Navs>
  );
}

/** A page whose rows respect the side safe areas (iPhone landscape, the iPhone Duo strip). */
function ListPage({ title }: { title: string }) {
  return (
    <NavLayout
      isApplicationRoot
      title={title}
      right={{ icon: <Pencil />, onClick: action("edit") }}
    >
      <Scrollable>
        <StyledRows>
          {Array.from({ length: 30 }, (_, i) => (
            <Link key={i} to={String(i + 1)}>
              {title} row {i + 1}
            </Link>
          ))}
        </StyledRows>
      </Scrollable>
    </NavLayout>
  );
}

/**
 * Back and icon buttons move to the strip where bars run vertically; the text
 * button ("Save") stays in the header, as Apple's guidance describes.
 */
function DetailPage({ title }: { title: string }) {
  return (
    <NavLayout
      title={title}
      right={[
        { title: "Save", onClick: action("save") },
        { icon: <Pencil />, onClick: action("edit") },
        { icon: <Ellipsis />, onClick: action("more") },
      ]}
    >
      <StyledDetail>{title}</StyledDetail>
    </NavLayout>
  );
}

const StyledDetail = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  font: ${fonts.display({ size: 15 })};
  color: ${colors.textSecondary()};
`;

const StyledRows = styled.div`
  padding-left: ${safeArea.left()};
  padding-right: ${safeArea.right()};
  padding-bottom: ${safeArea.bottom()};

  > a {
    display: block;
    text-decoration: none;
    padding: 14px 16px;
    border-bottom: 1px solid ${colors.separator()};
    font: ${fonts.display({ size: 15 })};
    color: ${colors.text()};
  }
`;

/**
 * The floating bar with the keyboard down and up, on a page that runs behind
 * the keyboard, as the native app's does: the keyboard covers the bar, and
 * the field at the bottom of the page scrolls up clear of the keyboard and of
 * a floating "+" that stays above it. Pages that extend under the bars (left
 * pair) and that don't (right pair).
 */
export const Keyboard: StoryObj = {
  render: () => (
    <StyledKeyboardDevices>
      <KeyboardDevice extendsUnderBars />
      <KeyboardDevice extendsUnderBars keyboard />
      <KeyboardDevice />
      <KeyboardDevice keyboard focus={false} />
    </StyledKeyboardDevices>
  ),
  decorators: [CrosswingAppDecorator({ layout: "fullscreen" })],
  parameters: { layout: "fullscreen" },
};

/**
 * A "+" that rides up on the keyboard instead, adding to the page's inset:
 * the field scrolls up clear of it too.
 */
export const KeyboardRidingButton: StoryObj = {
  render: () => (
    <StyledKeyboardDevices>
      <KeyboardDevice extendsUnderBars riding />
      <KeyboardDevice extendsUnderBars keyboard riding />
    </StyledKeyboardDevices>
  ),
  decorators: [CrosswingAppDecorator({ layout: "fullscreen" })],
  parameters: { layout: "fullscreen" },
};

function KeyboardDevice({
  extendsUnderBars,
  keyboard,
  focus = keyboard,
  riding,
}: {
  extendsUnderBars?: boolean;
  keyboard?: boolean;
  /** Only one field at a time can have it. */
  focus?: boolean;
  /** The "+" rides up on the keyboard. */
  riding?: boolean;
}) {
  const [history] = useState(() => new MemoryHistory());

  return (
    <MockDevice
      layout={iPhonePortraitLayout}
      keyboard={keyboard ? iPhonePortraitLayout.height - 336 : undefined}
      behindKeyboard
    >
      <Router
        history={history}
        render={() => (
          <Tabs>
            <Tab
              path="notes"
              title="Notes"
              icon={<Pencil size={22} />}
              render={() => (
                <KeyboardPage extendsUnderBars={extendsUnderBars} focus={focus} riding={riding} />
              )}
            />
            <Tab
              path="account"
              title="Account"
              icon={<User size={22} />}
              render={() => <SamplePage>Account</SamplePage>}
            />
          </Tabs>
        )}
      />
    </MockDevice>
  );
}

function KeyboardPage({
  extendsUnderBars,
  focus,
  riding,
}: {
  extendsUnderBars?: boolean;
  focus?: boolean;
  riding?: boolean;
}) {
  // Without scrolling the story itself to it.
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focus) field.current?.focus({ preventScroll: true });
  }, []);

  return (
    <NavLayout isApplicationRoot title="Notes" extendsUnderBars={extendsUnderBars}>
      <StyledKeyboardPage data-riding={!!riding}>
        <Scrollable>
          <div className="content">
            {Array.from({ length: 16 }, (_, i) => (
              <div key={i} className="row">
                Row {i + 1}
              </div>
            ))}
            <textarea ref={field} placeholder="Notes" defaultValue="The last field" />
          </div>
        </Scrollable>
        <button className="add">+</button>
      </StyledKeyboardPage>
    </NavLayout>
  );
}

const StyledKeyboardPage = styled.div`
  position: relative;
  display: flex;
  flex-flow: column;
  ${overlaySafeArea({ bottom: safeAreaResting.bottom("79px"), content: StyledScrollable })}

  > ${StyledScrollable} {
    height: 0;
    flex-grow: 1;
  }

  > ${StyledScrollable} > .content {
    display: flex;
    flex-flow: column;
    ${padSafeArea("top", "bottom", "left", "right")}

    > .row {
      padding: 14px 16px;
      border-bottom: 1px solid ${colors.separator()};
      font: ${fonts.display({ size: 15 })};
      color: ${colors.text()};
    }

    > textarea {
      margin: 16px;
      height: 60px;
      font: ${fonts.display({ size: 15 })};
    }
  }

  /* Stays put for the keyboard to cover. */
  > .add {
    position: absolute;
    right: 20px;
    bottom: calc(15px + ${safeAreaResting.bottom()});
    width: 48px;
    height: 48px;
    border-radius: 50%;
    border: none;
    background: ${colors.primary()};
    color: white;
    font-size: 24px;
  }

  &[data-riding="true"] {
    ${overlaySafeArea({ bottom: safeArea.bottom("79px"), content: StyledScrollable })}

    > .add {
      bottom: calc(15px + ${safeArea.bottom()});
    }
  }
`;

const StyledKeyboardDevices = styled.div`
  display: flex;
  flex-flow: row wrap;
  gap: 24px;
  padding: 24px;
`;
