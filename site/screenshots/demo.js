// A pretend Miks daemon for the website's screenshots: made-up workspaces,
// terminals and conversations, so nothing real (or private) is in them.
// Loaded before the UI (capture.mjs puts it in with CDP), with
// `window.__demo` saying what to show:
//
// - `bridge: "mac"`: stands in for Electron's preload (`window.miks`), as
//   in Miks's own window; `target` makes it a remote window.
// - `bridge: "web"`: swaps `WebSocket`, so the iOS app's bridge
//   (ui/webBridge.ts) connects to these Macs as it would over Tailscale.
(() => {
  const demo = { bridge: "mac", mac: "air", dark: true, target: null, ...window.__demo };
  const now = Date.now();
  const minutes = (n) => now - n * 60_000;

  //
  // Claude Code's screen, drawn as VT sequences to the terminal's width.
  //

  const esc = (code) => `\x1b[${code}m`;
  const reset = esc(0);
  const claude = (s) => esc("38;2;215;119;87") + s + reset;
  const dim = (s) => esc(2) + s + reset;
  const bold = (s) => esc(1) + s + reset;
  const gray = (s) => esc(demo.dark ? "38;5;245" : "38;5;242") + s + reset;
  const green = (s) => esc(demo.dark ? "38;2;120;200;120" : "38;2;30;130;50") + s + reset;
  const added = (s, cols) =>
    esc(demo.dark ? "48;2;34;60;38" : "48;2;220;245;222") + s.slice(0, cols - 2).padEnd(cols - 2) + reset;
  const removed = (s, cols) =>
    esc(demo.dark ? "48;2;72;36;38" : "48;2;252;225;225") + s.slice(0, cols - 2).padEnd(cols - 2) + reset;

  /** Wraps plain words to the width, each line after the first indented like the first. */
  function wrap(text, cols, indent = "  ") {
    const lines = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && (line + " " + word).length > cols - indent.length - 1) {
        lines.push(line);
        line = word;
      } else line = line ? line + " " + word : word;
    }
    if (line) lines.push(line);
    return lines;
  }

  const said = (text, cols) => wrap(text, cols).map((line, i) => (i === 0 ? claude("●") + " " : "  ") + line);
  const tool = (name, args) => `${claude("●")} ${bold(name)}(${args})`;
  const result = (...lines) => lines.map((line, i) => (i === 0 ? gray("  ⎿  ") : "     ") + line);
  const prompt = (text, cols) =>
    wrap(text, cols).map((line, i) => gray(i === 0 ? "> " : "  ") + gray(line));

  /** Claude Code's input box and footer, at the bottom of the screen. */
  function footer(cols, { working, mode = "⏵⏵ accept edits on", background } = {}) {
    const rule = gray("─".repeat(cols));
    return [
      working ? `${claude("✻")} ${claude(working)} ${gray("(esc to interrupt)")}` : "",
      "",
      rule,
      `${gray(">")} `,
      rule,
      gray(`  ${mode}`) + (background ? gray(` · ${background}`) : "") + gray(" (shift+tab to cycle)"),
    ];
  }

  function screen(lines, foot, rows) {
    const room = rows - foot.length;
    const shown = lines.slice(Math.max(0, lines.length - room));
    while (shown.length < room) shown.push("");
    const all = [...shown, ...foot];
    // The cursor in the input box, if there is one.
    const input = all.findLastIndex((line) => line.startsWith(gray(">")));
    return "\x1b[H\x1b[2J" + all.join("\r\n") + (input >= 0 ? `\x1b[${input + 1};3H` : "\x1b[?25l");
  }

  const screens = {
    search: (cols, rows) =>
      screen(
        [
          ...prompt("The product list is getting long. Add a search box above it that filters by name as you type.", cols),
          "",
          ...said("I'll look at how the list is rendered first.", cols),
          "",
          tool("Read", "src/components/ProductList.tsx"),
          ...result("Read 84 lines"),
          "",
          tool("Update", "src/components/ProductList.tsx"),
          ...result(`Updated ${bold("src/components/ProductList.tsx")} with 14 additions and 2 removals`),
          gray("       ") + gray("12") + "   export function ProductList({ products }: Props) {",
          gray("       ") + added("13 +   const [query, setQuery] = useState(\"\");", cols - 7),
          gray("       ") + added("14 +   const shown = useFiltered(products, query);", cols - 7),
          gray("       ") + removed("15 -   return <Grid items={products} />;", cols - 7),
          gray("       ") + added("15 +   return (", cols - 7),
          gray("       ") + added("16 +     <>", cols - 7),
          gray("       ") + added("17 +       <SearchField value={query} onChange={setQuery} />", cols - 7),
          gray("       ") + added("18 +       <Grid items={shown} />", cols - 7),
          "",
          tool("Bash", "npm test -- ProductList"),
          ...result(green("PASS") + " src/components/ProductList.test.tsx", green("✓") + " filters by name as you type " + gray("(31 ms)"), green("✓") + " shows everything when empty " + gray("(4 ms)"), gray("Tests: 6 passed, 6 total")),
          "",
          ...said("Done. There's a search box above the product list now. It filters by name, ignoring case and accents, and waits 150ms after you stop typing so a long list doesn't stutter.", cols),
          "",
        ],
        footer(cols),
        rows,
      ),
    permission: (cols, rows) => {
      const rule = claude("─".repeat(cols));
      return screen(
        [
          ...prompt("Rate limits are being hit by the nightly import. Find out why.", cols),
          "",
          ...said("The import calls the API once per row. I'll check how many rows it sends.", cols),
          "",
          tool("Bash", "psql $DATABASE_URL -c \"select count(*) from imports\""),
          "",
        ],
        [
          rule,
          ` ${bold("Bash command")}`,
          "",
          `   psql $DATABASE_URL -c "select count(*) from imports"`,
          gray("   Count the rows waiting to import"),
          "",
          " Do you want to proceed?",
          ` ${claude("❯")} ${claude("1. Yes")}`,
          "   2. Yes, and don't ask again for psql commands",
          "   3. No, and tell Claude what to do differently " + gray("(esc)"),
          "",
        ],
        rows,
      );
    },
    working: (cols, rows) =>
      screen(
        [
          ...prompt("Upgrade the app to the new navigation library and fix whatever breaks.", cols),
          "",
          ...said("I'll start the simulator build in the background and work through the errors as they come.", cols),
          "",
          tool("Bash", "npx expo run:ios"),
          ...result(gray("Running in the background (↓ to manage)")),
          "",
          tool("Update", "app/(tabs)/_layout.tsx"),
          ...result(`Updated ${bold("app/(tabs)/_layout.tsx")} with 9 additions and 11 removals`),
          "",
        ],
        footer(cols, { working: "Rewiring the tab bar…", background: "1 shell" }),
        rows,
      ),
    train: (cols, rows) =>
      screen(
        [
          ...prompt("We relabeled 40k images last week. Retrain the classifier on the new labels and tell me if accuracy moves.", cols),
          "",
          ...said("I'll train on the GPU in the background and watch the validation loss as it goes.", cols),
          "",
          tool("Bash", "uv run train.py --labels labels-v7.parquet --epochs 30"),
          ...result(gray("Running in the background (↓ to manage)")),
          "",
          tool("Monitor", "validation loss, every epoch"),
          ...result(
            "epoch  9/30  train 0.412  val 0.468  acc " + bold("88.1%"),
            "epoch 10/30  train 0.398  val 0.455  acc " + bold("88.6%"),
            "epoch 11/30  train 0.381  val 0.449  acc " + bold("89.0%"),
            "epoch 12/30  train 0.367  val 0.441  acc " + green(bold("89.4%")),
          ),
          "",
          ...said("Validation accuracy is already past the old model's 87.2% at epoch 12, and still climbing. About 25 minutes to go; I'll compare per-class results once it's done.", cols),
          "",
        ],
        footer(cols, { working: "Waiting on epoch 13…", background: "1 shell, 1 monitor" }),
        rows,
      ),
    idle: (cols, rows) =>
      screen(
        [
          ...prompt("Proofread the getting started guide.", cols),
          "",
          ...said("Fixed four typos and one broken link. The guide reads well otherwise.", cols),
          "",
        ],
        footer(cols, { mode: "? for shortcuts" }),
        rows,
      ),
    dev: (cols, rows) =>
      "\x1b[H\x1b[2J" +
      [
        gray("~/Code/storefront") + " " + green("❯") + " npm run dev",
        "",
        "  " + bold(green("VITE")) + green(" v8.2.0") + "  ready in 212 ms",
        "",
        "  " + green("➜") + "  " + bold("Local") + ":   " + esc("36") + "http://localhost:" + bold("3000") + esc("36") + "/" + reset,
        "  " + green("➜") + "  " + dim("Network: use --host to expose"),
        "",
        gray("9:41:02 AM") + " " + esc("36") + bold("[vite]") + reset + " " + green("hmr update") + " " + dim("/src/components/ProductList.tsx"),
        gray("9:41:07 AM") + " " + esc("36") + bold("[vite]") + reset + " " + green("hmr update") + " " + dim("/src/components/SearchField.tsx"),
      ].join("\r\n"),
    commit: () =>
      "\x1b[H\x1b[2J" +
      [
        gray("~/Code/infra") + " " + green("❯") + " git add -A && git commit",
        "hint: Waiting for your editor to close the file...",
      ].join("\r\n"),
    shell: () =>
      "\x1b[H\x1b[2J" +
      [
        gray("~/Code/infra") + " " + green("❯") + " terraform plan",
        "",
        "No changes. Your infrastructure matches the configuration.",
        "",
        gray("~/Code/infra") + " " + green("❯") + " ",
      ].join("\r\n"),
  };

  //
  // The Macs.
  //

  const tab = (id, title, extra = {}) => ({ id, key: id, title, cwd: null, agent: null, ...extra });
  const agent = (status, since, extra = {}) => ({ kind: "claude", status, since: minutes(since), ...extra });
  const workspace = (id, cwd, tabs, extra = {}) => ({
    id,
    title: null,
    cwd,
    tabs: tabs.map((t) => ({ ...t, cwd: t.cwd ?? cwd })),
    activeTabId: tabs[0].id,
    ...extra,
  });

  const searchChat = [
    { id: "1", kind: "prompt", text: "The product list is getting long. Add a search box above it that filters by name as you type.", time: minutes(6) },
    { id: "2", kind: "reply", text: "I'll look at how the list is rendered first.", time: minutes(6) },
    { id: "3", kind: "tool", name: "Read", summary: "src/components/ProductList.tsx", time: minutes(6) },
    {
      id: "4",
      kind: "tool",
      name: "Edit",
      summary: "src/components/ProductList.tsx",
      detail: '-  return <Grid items={products} />;\n+  const [query, setQuery] = useState("");\n+  const shown = useFiltered(products, query);',
      time: minutes(5),
    },
    { id: "5", kind: "tool", name: "Bash", summary: "npm test -- ProductList", detail: "npm test -- ProductList", time: minutes(4) },
    {
      id: "6",
      kind: "reply",
      text:
        "Done. There's a search box above the product list now.\n\n" +
        "- It filters by **name**, ignoring case and accents\n" +
        "- It waits 150ms after you stop typing, so a long list doesn't stutter\n" +
        "- An empty box shows everything again\n\n" +
        "The filtering lives in a small hook, so the order page can use it too:\n\n" +
        "```ts\nconst shown = useFiltered(products, query);\n```\n\n" +
        "All 6 tests pass. Want me to add the same box to the order history?",
      time: minutes(3),
    },
  ];

  const plan = [
    "# Launch checklist",
    "",
    "What's left before the storefront goes live on **Friday**.",
    "",
    "## Must have",
    "",
    "- [x] Search on the product list",
    "- [x] Apple Pay at checkout",
    "- [ ] Order confirmation emails (waiting on copy from Dana)",
    "- [ ] Load test the import at 10× today's catalog",
    "",
    "## Nice to have",
    "",
    "| Idea | Effort | Notes |",
    "| --- | --- | --- |",
    "| Saved carts | Small | Already in local storage |",
    "| Gift cards | Large | Needs a new ledger table |",
    "| Dark mode | Small | The design tokens are ready |",
    "",
    "> Ship small, ship Friday. Everything else can be a point release.",
    "",
    "Run the checks with `npm run check` before tagging.",
  ].join("\n");

  const macs = {
    air: {
      home: "/Users/sam",
      activeWorkspaceId: "w1",
      workspaces: [
        workspace(
          "w1",
          "/Users/sam/Code/storefront",
          [
            tab("t1", "✳ Product search box", {
              agent: agent("done", 3, { replyLines: 9, reply: "Done. There's a search box above the product list now." }),
              running: "claude",
              kept: true,
            }),
            tab("t2", "npm run dev", { running: "npm run dev", kept: true }),
          ],
        ),
        workspace(
          "w2",
          "/Users/sam/Code/api",
          [tab("t3", "✳ Nightly import rate limits", { agent: agent("waiting", 1, { message: "Wants to run psql" }), running: "claude", kept: true })],
        ),
        workspace(
          "w3",
          "/Users/sam/Code/mobile",
          [tab("t4", "◐ Navigation upgrade", { agent: agent("working", 0), running: "claude", kept: true, background: { shells: 1, monitors: 0, agents: 0 } })],
        ),
        workspace("w4", "/Users/sam/Code/docs", [tab("t5", "✳ Proofread guide", { agent: agent("idle", 40), running: "claude", kept: true })]),
        workspace("w5", "/Users/sam/Code/infra", [tab("t6", "zsh")], { title: "infra" }),
      ],
    },
    studio: {
      home: "/Users/sam",
      activeWorkspaceId: "s1",
      workspaces: [
        workspace(
          "s1",
          "/Users/sam/Code/ml-pipeline",
          [tab("u1", "◐ Retrain on the new labels", { agent: agent("working", 0), running: "claude", kept: true, background: { shells: 1, monitors: 1, agents: 0 } })],
        ),
        workspace("s2", "/Users/sam/Code/video-render", [tab("u2", "✳ Render queue retries", { agent: agent("done", 12), running: "claude", kept: true })]),
        workspace("s3", "/Users/sam/Code/home-server", [tab("u3", "zsh")], { title: "home-server" }),
      ],
    },
  };
  for (const state of Object.values(macs)) state.protocol = 13;

  /** What each tab's terminal shows. */
  const tabScreens = { t1: "search", t2: "dev", t3: "permission", t4: "working", t5: "idle", t6: "commit", u1: "train", u2: "idle", u3: "shell" };
  const chats = { t1: searchChat };
  const commit = [
    "Move the nightly import to the queue",
    "",
    "It called the API once per row, which hit",
    "the rate limit past ~8k rows. It now sends",
    "500 rows per job, with retries.",
    "",
    "# Please enter the commit message for your",
    "# changes. Lines starting with '#' will be",
    "# ignored.",
    "#",
    "# On branch main",
    "# Changes to be committed:",
    "#\tmodified:   jobs/import.tf",
    "#\tmodified:   jobs/worker.tf",
    "#\tnew file:   jobs/queues.tf",
    "#",
  ].join("\n");
  const files = { "PLAN.md": plan, COMMIT_EDITMSG: commit };

  // A scene can open files and pages in tabs, and pick the workspace on screen.
  for (const [name, state] of Object.entries(macs)) {
    const scene = demo.scenes?.[name];
    if (!scene) continue;
    if (scene.activeWorkspaceId) state.activeWorkspaceId = scene.activeWorkspaceId;
    for (const workspace of state.workspaces) {
      Object.assign(workspace, scene.workspaces?.[workspace.id]);
      for (const t of workspace.tabs) Object.assign(t, scene.tabs?.[t.id]);
    }
  }

  /** Answers one client message the way the daemon would, as `reply(message)`s. */
  function daemon(name, raw, reply) {
    const m = JSON.parse(raw);
    const state = macs[name];
    const tabOf = (id) => state.workspaces.flatMap((w) => w.tabs).find((t) => t.id === id);
    if (m.type === "hello") reply({ type: "state", state });
    if (m.type === "select") {
      state.activeWorkspaceId = m.workspaceId;
      const ws = state.workspaces.find((w) => w.id === m.workspaceId);
      if (ws && m.tabId) ws.activeTabId = m.tabId;
      reply({ type: "state", state });
    }
    if (m.type === "attach") {
      const cols = m.cols || 100;
      const rows = m.rows || 30;
      reply({ type: "snapshot", tabId: m.tabId, cols, rows, data: screens[tabScreens[m.tabId] ?? "shell"](cols, rows) });
    }
    if (m.type === "resize") {
      reply({ type: "output", tabId: m.tabId, data: screens[tabScreens[m.tabId] ?? "shell"](m.cols, m.rows) });
    }
    if (m.type === "watchChat") reply({ type: "chat", tabId: m.tabId, session: "s-" + m.tabId, entries: chats[m.tabId] ?? [], reset: true });
    if (m.type === "watchFile") {
      const t = tabOf(m.tabId);
      const file = t?.files?.find((f) => f.id === m.fileId) ?? t?.file;
      if (file) reply({ type: "file", tabId: m.tabId, id: file.id, content: files[file.path.split("/").pop()] ?? "", mtime: now });
    }
    if (m.type === "running") reply({ type: "running", requestId: m.requestId, running: [] });
    if (m.type === "findPaths") reply({ type: "paths", requestId: m.requestId, found: m.paths.map(() => null) });
    if (m.type === "permissions") reply({ type: "permissions", app: "Miks Helper", permissions: [] });
  }

  //
  // The bridges.
  //

  if (demo.bridge === "mac") {
    const listeners = { message: new Set(), status: new Set(), settings: new Set() };
    const subscribe = (set, listener) => (set.add(listener), () => set.delete(listener));
    const name = demo.target ? demo.target.mac : demo.mac;
    const settings = {
      fontSize: 13,
      hidePathPrefix: "~/Code/",
      notifications: true,
      sidebarVisible: true,
      chatForLongReplies: true,
      keepDaemonRunning: false,
      claudeHooks: true,
      optionAsMeta: true,
      browser: "",
      remotes: [],
      tailnetAccess: false,
      ...demo.settings,
    };
    window.miks = {
      connect: () => setTimeout(() => listeners.status.forEach((l) => l({ connected: true })), 50),
      send: (raw) =>
        daemon(name, raw, (msg) => setTimeout(() => listeners.message.forEach((l) => l(JSON.stringify(msg))), 5)),
      onMessage: (l) => subscribe(listeners.message, l),
      onStatus: (l) => subscribe(listeners.status, l),
      onCommand: () => () => {},
      pathForFile: () => "",
      sendFiles: async () => [],
      sendClipboardImage: async () => ({ image: false }),
      browsePartition: async () => "persist:demo",
      chooseBrowser: async () => null,
      getSettings: () => settings,
      setSettings: (changes) => Object.assign(settings, changes),
      onSettings: (l) => subscribe(listeners.settings, l),
      focus: () => {},
      getTarget: () => demo.target,
      onTarget: () => () => {},
      openRemote: () => {},
      confirm: async () => true,
      copy: () => {},
    };
  } else {
    class FakeSocket {
      static OPEN = 1;
      constructor(url) {
        this.readyState = 0;
        this.name = new URL(url).hostname.split(".")[0];
        setTimeout(() => {
          this.readyState = 1;
          this.onopen?.();
        }, 50);
      }
      send(raw) {
        daemon(this.name, raw, (msg) => setTimeout(() => this.readyState === 1 && this.onmessage?.({ data: JSON.stringify(msg) }), 5));
      }
      close() {
        this.readyState = 3;
      }
    }
    window.WebSocket = FakeSocket;

    // In the app: no asking for notifications over the screenshot.
    try {
      delete window.Notification;
    } catch {}
    const handler = window.webkit?.messageHandlers?.default;
    if (handler) {
      const post = handler.postMessage.bind(handler);
      try {
        handler.postMessage = (message) => message?.name !== "requestNotificationAuthorization" && post(message);
      } catch {}
    }
  }

  // The simulator counts the Mac's keyboard as a hardware one, which hides the key bar.
  if (demo.noHardwareKeyboard) setInterval(() => window.miks_hardwareKeyboard?.(false), 200);

  // Electron's <webview>, for `miks browse`: the page, in a frame.
  if (demo.pages) {
    new MutationObserver(() => {
      for (const view of document.querySelectorAll("webview:not([data-demo])")) {
        view.setAttribute("data-demo", "");
        const frame = document.createElement("iframe");
        frame.srcdoc = demo.pages[view.getAttribute("src")] ?? "";
        frame.style.cssText = "border:0;width:100%;height:100%;display:block;background:white";
        view.style.display = "block";
        view.append(frame);
      }
    }).observe(document, { childList: true, subtree: true });
  }
})();
