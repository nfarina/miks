// Takes the website's screenshots: the real UI, in headless Chrome, on the
// pretend daemon in demo.js. With the UI's Vite running:
//
//   yarn ui
//   node site/screenshots/capture.mjs [scene...]
//
// Each scene is a window size, what demo.js shows, and what's clicked.
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const here = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(here, "..", "img");
const UI = process.env.UI ?? "http://localhost:4810/";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9341;

const demoSource = fs.readFileSync(path.join(here, "demo.js"), "utf8");
const storefront = fs.readFileSync(path.join(here, "storefront.html"), "utf8");
const air = "air.tail.ts.net:2741";
const studio = "studio.tail.ts.net:2741";

const mac = { width: 1440, height: 900, scale: 2, ua: "Electron" };
const phone = { width: 390, height: 844, scale: 3, mobile: true, safeArea: { top: "47px", bottom: "34px", left: "0px", right: "0px" } };
const ipad = { width: 1376, height: 1032, scale: 2, mobile: true, safeArea: { top: "24px", bottom: "20px", left: "0px", right: "0px" } };

const scenes = {
  // Not the UI: the iPhone Duo's screenshot (README.md), folded into laptop pose.
  "duo-laptop": { file: "duo-pose.html", width: 600, height: 700, scale: 2 },
  "mac-chat": {
    ...mac,
    dark: true,
    demo: { bridge: "mac" },
    storage: { "ChatPanel:open": ["t1"] },
  },
  "mac-chat-light": {
    ...mac,
    dark: false,
    demo: { bridge: "mac" },
    storage: { "ChatPanel:open": ["t1"] },
  },
  "mac-open": {
    ...mac,
    dark: false,
    demo: {
      bridge: "mac",
      scenes: {
        air: {
          tabs: {
            t1: { files: [{ id: "f1", path: "/Users/sam/Code/storefront/PLAN.md", edit: false, wait: false }] },
          },
        },
      },
    },
    storage: { "ChatPanel:open": ["t1"] },
    after: async (page) => {
      // The file, not the chat: the panel's switcher.
      await page.click("PLAN.md");
    },
  },
  "mac-edit": {
    ...mac,
    dark: true,
    demo: {
      bridge: "mac",
      scenes: {
        air: {
          activeWorkspaceId: "w5",
          tabs: {
            t6: {
              title: "git commit",
              running: "git commit",
              file: { id: "f2", path: "/Users/sam/Code/infra/.git/COMMIT_EDITMSG", edit: true, wait: true },
              files: [{ id: "f2", path: "/Users/sam/Code/infra/.git/COMMIT_EDITMSG", edit: true, wait: true }],
            },
          },
        },
      },
    },
    storage: { "ChatPanel:open": ["t6"] },
  },
  "mac-browse": {
    ...mac,
    dark: true,
    demo: {
      bridge: "mac",
      pages: { "http://localhost:3000/": storefront },
      scenes: {
        air: {
          tabs: { t2: { page: { id: "p1", url: "http://localhost:3000/" } } },
          workspaces: { w1: { activeTabId: "t2" } },
        },
      },
    },
    storage: { "ChatPanel:open": ["t2"] },
  },
  "mac-remote": {
    ...mac,
    dark: true,
    demo: { bridge: "mac", target: { name: "studio", color: "#8b5cf6", host: "studio.local", mac: "studio" } },
  },
  "phone-macs": {
    ...phone,
    dark: true,
    demo: { bridge: "web" },
    storage: { "miks-macs": [studio, air], "miks-macs-seen": { [studio]: Date.now() - 3600_000, [air]: Date.now() - 120_000 } },
  },
  "phone-chat": {
    ...phone,
    dark: true,
    demo: { bridge: "web" },
    storage: { "miks-mac": air, "miks-macs": [air, studio], "ChatPanel:open": ["t1"], "miks-settings": { sidebarVisible: false } },
  },
  "phone-sidebar": {
    ...phone,
    dark: true,
    demo: { bridge: "web" },
    storage: { "miks-mac": air, "miks-macs": [air, studio], "miks-settings": { sidebarVisible: true } },
  },
  "ipad-chat": {
    ...ipad,
    dark: false,
    demo: { bridge: "web" },
    storage: { "miks-mac": air, "miks-macs": [air, studio], "ChatPanel:open": ["t1"] },
  },
};

const chosen = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A Chrome for each scale.
const scales = [...new Set(Object.values(scenes).map((scene) => scene.scale))];
for (const scale of scales) {
  const todo = Object.entries(scenes).filter(([name, scene]) => scene.scale === scale && (!chosen.length || chosen.includes(name)));
  if (!todo.length) continue;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "miks-shots-"));
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    // Emulating the scale instead (setDeviceMetricsOverride) left xterm.js's
    // WebGL drawing each glyph at twice its cell's size.
    `--force-device-scale-factor=${scale}`,
    "about:blank",
  ]);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    if (await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => true, () => false)) break;
  }
  try {
    for (const [name, scene] of todo) await shoot(name, scene);
  } finally {
    chrome.kill();
    await new Promise((r) => chrome.once("exit", r));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function shoot(name, scene) {
  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const sock = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (sock.onopen = r));
  let id = 0;
  const pending = new Map();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  };
  const call = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      sock.send(JSON.stringify({ id: i, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(`${name}: ${r.result.exceptionDetails.exception?.description}`);
    return r.result?.result?.value;
  };
  const page = {
    evaluate,
    sleep,
    /** Clicks the innermost element whose text is exactly this. */
    click: async (text) => {
      const ok = await evaluate(`(() => {
        const el = [...document.querySelectorAll("body *")].filter((e) => e.textContent.trim() === ${JSON.stringify(text)}).pop();
        if (!el) return false;
        for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true }));
        return true;
      })()`);
      if (!ok) throw new Error(`${name}: nothing says "${text}"`);
      await sleep(600);
    },
  };

  await call("Page.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: scene.width,
    height: scene.height,
    deviceScaleFactor: 0,
    mobile: !!scene.mobile,
  });
  if (scene.mobile) await call("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: scene.dark ? "dark" : "light" }] });
  if (scene.ua) {
    const ua = (await evaluate("navigator.userAgent")).replace("HeadlessChrome", "Chrome");
    await call("Emulation.setUserAgentOverride", { userAgent: `${ua} Electron/44.0.0` });
  }
  const storage = Object.entries(scene.storage ?? {})
    .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(typeof v === "string" ? v : JSON.stringify(v))});`)
    .join("");
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.clear(); ${storage} window.__demo = ${JSON.stringify({ dark: scene.dark, ...scene.demo })};\n${demoSource}`,
  });
  if (scene.file) {
    await call("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
    await call("Page.navigate", { url: `file://${path.join(here, scene.file)}` });
    await sleep(1000);
    const box = JSON.parse(await evaluate(`JSON.stringify(document.body.getBoundingClientRect())`));
    const shot = await call("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: box.width, height: box.height, scale: 1 } });
    fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(shot.result.data, "base64"));
    console.log("shot", name);
    await call("Page.close").catch(() => {});
    return sock.close();
  }
  await call("Page.navigate", { url: UI });
  await sleep(2500);
  if (scene.safeArea) {
    await evaluate(`window.onSafeAreaChange?.(${JSON.stringify(JSON.stringify(scene.safeArea))})`);
    await sleep(300);
  }
  await scene.after?.(page);
  await sleep(800);
  await evaluate(`(${chrome_overlay})(${JSON.stringify({ mac: !!scene.ua, phone: !!scene.safeArea, width: scene.width, dark: scene.dark, ipad: scene.width > 800 })})`);
  await sleep(200);

  const shot = await call("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(out, `${name}.png`), Buffer.from(shot.result.data, "base64"));
  console.log("shot", name);
  await call("Page.close").catch(() => {});
  sock.close();
}

/** What the screenshot gets that the page doesn't draw: the window's buttons, or the phone's status bar. */
function chrome_overlay({ mac, phone, dark, ipad }) {
  const layer = document.createElement("div");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:100000";
  if (mac) {
    for (const [i, color] of ["#ff5f57", "#febc2e", "#28c840"].entries()) {
      const dot = document.createElement("div");
      dot.style.cssText = `position:absolute;top:14px;left:${14 + i * 20}px;width:12px;height:12px;border-radius:50%;background:${color};box-shadow:inset 0 0 0 0.5px #0002`;
      layer.append(dot);
    }
  } else if (phone) {
    const ink = dark ? "#fff" : "#000";
    const bar = document.createElement("div");
    bar.style.cssText = `position:absolute;top:0;left:0;right:0;height:${ipad ? 24 : 47}px;display:flex;align-items:center;justify-content:space-between;padding:${ipad ? "0 22px" : "0 34px 0 44px"};font:600 ${ipad ? 13 : 16}px -apple-system,system-ui;color:${ink};box-sizing:border-box`;
    bar.innerHTML = `<span>9:41</span><span style="display:flex;gap:6px;align-items:center">
      <svg width="18" height="12" viewBox="0 0 18 12"><g fill="${ink}"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>
      <svg width="16" height="12" viewBox="0 0 16 12"><path fill="${ink}" d="M8 2.2c2.3 0 4.4.9 6 2.4l1.2-1.3A10.2 10.2 0 0 0 8 .4C5.2.4 2.7 1.5.8 3.3L2 4.6a8.5 8.5 0 0 1 6-2.4Zm0 3.6c1.3 0 2.5.5 3.4 1.3l1.2-1.3a6.7 6.7 0 0 0-9.2 0l1.2 1.3c.9-.8 2.1-1.3 3.4-1.3Zm0 3.6c-.5 0-1 .2-1.3.5L8 11.6l1.3-1.7c-.3-.3-.8-.5-1.3-.5Z"/></svg>
      <svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="${ink}" stroke-opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="${ink}"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill="${ink}" fill-opacity=".4"/></svg>
    </span>`;
    layer.append(bar);
    if (!ipad) {
      const island = document.createElement("div");
      island.style.cssText = "position:absolute;top:11px;left:50%;transform:translateX(-50%);width:124px;height:36px;border-radius:18px;background:#000";
      layer.append(island);
      const home = document.createElement("div");
      home.style.cssText = `position:absolute;bottom:8px;left:50%;transform:translateX(-50%);width:134px;height:5px;border-radius:3px;background:${ink}`;
      layer.append(home);
    }
  }
  document.body.append(layer);
}
