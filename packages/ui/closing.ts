import { describeBackground, totalBackground } from "miks/shared/background";
import type { Tab, Workspace } from "miks/shared/protocol";
import { daemon } from "./daemon";

// Closing a tab ends its shell and whatever's running in it, for good, so
// it asks first when that's more than a shell.

export async function closeTab(tab: Tab) {
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

function confirmClose(message: string, detail: string): Promise<boolean> {
  return window.miks?.confirm({ message, detail, button: "Close" }) ?? Promise.resolve(true);
}
