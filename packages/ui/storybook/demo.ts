// The website's pretend daemon (site/screenshots/demo.js), which the UI
// reaches as the iOS app reaches a Mac: demo.js swaps `WebSocket` under
// webBridge.ts. Imported before anything that imports the bridge.
const air = "air.tail.ts.net:2741";
const studio = "studio.tail.ts.net:2741";

localStorage.setItem("miks-mac", air);
localStorage.setItem("miks-macs", JSON.stringify([air, studio]));
localStorage.setItem("ChatPanel:open", JSON.stringify(["t1"]));

(window as any).__demo = {
  bridge: "web",
  dark: matchMedia("(prefers-color-scheme: dark)").matches,
  // A file in the first tab's panel too, beside its chat.
  scenes: {
    air: {
      tabs: {
        t1: { files: [{ id: "f1", path: "/Users/sam/Code/storefront/PLAN.md", edit: false, wait: false }] },
      },
    },
  },
};
