import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { defineConfig } from "vite";

/**
 * Which Miks this UI is, for `miks version` (`ClientInfo.ui`): as
 * scripts/build-app.ts stamps build.json, and from the dev server, the commit
 * it started on.
 */
function build(dev: boolean) {
  const root = path.resolve(import.meta.dirname, "../..");
  const { version } = JSON.parse(fs.readFileSync(path.join(root, "packages/app/package.json"), "utf8"));
  let commit: string | null = null;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 2000 }).trim();
    commit = git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain", "--untracked-files=no") ? "+changes" : "");
  } catch {}
  return { version, commit, built: dev ? null : new Date().toISOString(), ...(dev && { dev: true }) };
}

export default defineConfig(({ command }) => ({
  define: {
    __MIKS_BUILD__: JSON.stringify(build(command === "serve")),
  },
  plugins: [
    react(),
    babel({
      presets: [reactCompilerPreset()],
    }),
  ],
  oxc: {
    plugins: {
      styledComponents: { fileName: false },
    },
  },
  // The built UI is loaded from disk (file://), so its asset URLs must be relative.
  base: "./",
  build: {
    // Don't minify the output; it doesn't increase performance and makes
    // debugging harder.
    minify: false,
  },
  clearScreen: false,
}));
