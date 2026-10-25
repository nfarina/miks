import { describeBackground, totalBackground } from "miks/shared/background";
import type { Tab, Workspace } from "miks/shared/protocol";
import { daemon } from "./daemon";

// Closing a tab ends its shell and whatever's running in it, for good, so
// it asks first when that's more than a shell.

export async function closeTab(tab: Tab) {
  if (busy(tab)) tab = await settled(tab);
  const background = describeBackground(tab.background);
  const detail = background
    ? `${tab.running ?? "Claude Code"} is running in it, with ${background} in the background, and closing stops them.`
    : `${tab.running} is running in it, and closing stops it.`;
  if ((tab.running || background) && !(await confirmClose("Close this tab?", detail))) return;
  daemon.send({ type: "closeTab", tabId: tab.id });
}

export async function closeWorkspace(workspace: Workspace) {
  const running = workspace.tabs.flatMap((tab) => (tab.running ? [tab.running] : []));
  if (running.length > 0) {
    const background = describeBackground(totalBackground(workspace.tabs.map((tab) => tab.background)));
    const what = [...new Set(running)].join(", ") + (background ? ` (with ${background} in the background)` : "");
    const tabs = workspace.tabs.length === 1 ? "its tab" : `its ${workspace.tabs.length} tabs`;
    if (!(await confirmClose("Close this workspace?", `Closing it closes ${tabs}, stopping ${what}.`))) return;
  }
  daemon.send({ type: "closeWorkspace", workspaceId: workspace.id });
}

const busy = (tab: Tab) => !!tab.running || !!describeBackground(tab.background);

/**
 * The tab once what's running in it has had a moment to quit: a Claude Code
 * just sent ⌃D a few times takes a second or two, and asking about it then
 * was a question with no point. The daemon looks at what's in front every
 * 500ms, so this waits for that to come through, for up to 2s.
 */
function settled(tab: Tab): Promise<Tab> {
  const current = () => daemon.getSnapshot().state?.workspaces.flatMap((workspace) => workspace.tabs).find((each) => each.id === tab.id) ?? tab;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      unsubscribe();
      resolve(current());
    };
    const timer = setTimeout(done, 2000);
    const unsubscribe = daemon.subscribe(() => {
      if (!busy(current())) done();
    });
  });
}

function confirmClose(message: string, detail: string): Promise<boolean> {
  return window.miks?.confirm({ message, detail, button: "Close" }) ?? Promise.resolve(true);
}
