import babel from "@rolldown/plugin-babel";
import type { StorybookConfig } from "@storybook/react-vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { mergeConfig } from "vite";

export default {
  stories: ["../packages/**/*.stories.@(ts|tsx)"],
  framework: {
    name: "@storybook/react-vite",
    options: { strictMode: true },
  },
  core: {
    disableWhatsNewNotifications: true,
  },
  // As packages/ui/vite.config.ts: crosswing's modals need the React Compiler.
  async viteFinal(config) {
    return mergeConfig(config, {
      plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
      oxc: { plugins: { styledComponents: { fileName: false } } },
    });
  },
} satisfies StorybookConfig;
