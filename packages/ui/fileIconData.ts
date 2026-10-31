// Material Icon Theme's map of names to icons, and the icons themselves,
// loaded apart from the app (fileIcons.tsx): over 1,000 of them.
import manifest from "material-icon-theme/dist/material-icons.json";

const files = import.meta.glob<string>("../../node_modules/material-icon-theme/icons/*.svg", { query: "?raw", import: "default", eager: true });

export const icons = Object.fromEntries(Object.entries(files).map(([path, svg]) => [path.split("/").pop()!.replace(/\.svg$/, ""), svg]));

export { manifest };
