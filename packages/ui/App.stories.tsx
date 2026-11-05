// In this order: the pretend Macs, then the bridge to them, then the UI.
import "./storybook/demo";
import "../../site/screenshots/demo.js";
import "./webBridge";
import type { Meta, StoryObj } from "@storybook/react";
import { DeviceSimulator } from "crosswing/host/mocks/simulator";
import { MockDevice } from "crosswing/host/mocks/device";
import {
  duoBookLayout,
  duoClosedLandscapeLayout,
  duoClosedPortraitLayout,
  duoLaptopLayout,
  duoOpenLandscapeLayout,
  duoOpenPortraitLayout,
} from "crosswing/host/mocks/layouts";
import type { HostLayout } from "crosswing/host/types";
import { ModalRootProvider } from "crosswing/modals/context";
import { CrosswingAppDecorator } from "crosswing/storybook";
import { styled } from "styled-components";
import { App } from "./App";
import { miksFonts, systemUI } from "./fonts";

/**
 * The whole UI as the iOS app shows it, on the website's pretend daemon, for
 * checking the safe area (the iPhone Duo's strip, cameras, corners and fold).
 * Media queries still see the browser window, not the device: emulate a touch
 * screen (DevTools) for the ones about touch.
 */
export default {
  title: "Miks/App",
  parameters: { layout: "fullscreen" },
  decorators: [CrosswingAppDecorator({ layout: "fullscreen", faces: [systemUI], fonts: miksFonts })],
} satisfies Meta;

/** Every device and pose crosswing has a layout for, picked from a toolbar. */
export const Simulator: StoryObj = {
  render: () => (
    <DeviceSimulator style={{ height: "100vh" }}>
      <ModalRootProvider allowDesktopPresentation>
        <App />
      </ModalRootProvider>
    </DeviceSimulator>
  ),
};

export const DuoClosed: StoryObj = { render: () => <Device layout={duoClosedPortraitLayout} /> };
export const DuoClosedLandscape: StoryObj = { render: () => <Device layout={duoClosedLandscapeLayout} /> };
export const DuoBook: StoryObj = { render: () => <Device layout={duoBookLayout} /> };
export const DuoLaptop: StoryObj = { render: () => <Device layout={duoLaptopLayout} /> };
export const DuoOpen: StoryObj = { render: () => <Device layout={duoOpenLandscapeLayout} /> };
export const DuoOpenPortrait: StoryObj = { render: () => <Device layout={duoOpenPortraitLayout} /> };

function Device({ layout }: { layout: HostLayout }) {
  return (
    <StyledStage>
      <MockDevice layout={layout}>
        <ModalRootProvider allowDesktopPresentation>
          <App />
        </ModalRootProvider>
      </MockDevice>
    </StyledStage>
  );
}

const StyledStage = styled.div`
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
`;
