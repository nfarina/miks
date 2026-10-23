import { colors } from "crosswing/colors";
import { describeBackground, totalBackground } from "miks/shared/background";
import { AgentStatus, Tab, Workspace } from "miks/shared/protocol";

/** Most urgent first: what a workspace shows when its tabs disagree. */
export const URGENCY: AgentStatus[] = ["waiting", "done", "working", "idle"];

export function workspaceStatus(workspace: Workspace): AgentStatus | null {
  const statuses = workspace.tabs.map((tab) => tab.agent?.status).filter(Boolean) as AgentStatus[];
  return URGENCY.find((status) => statuses.includes(status)) ?? null;
}

/** The waiting agent's own explanation, if it gave one. */
export function waitingMessage(workspace: Workspace): string | null {
  return workspace.tabs.find((tab) => tab.agent?.status === "waiting")?.agent?.message ?? null;
}

/** What the workspace's Claude sessions have running in the background, as their footers say it: "1 shell, 1 monitor". */
export function backgroundSummary(workspace: Workspace): string | null {
  return describeBackground(totalBackground(workspace.tabs.map((tab) => tab.background)));
}

export function workspaceTitle(workspace: Workspace): string {
  const activeTab = workspace.tabs.find((tab) => tab.id === workspace.activeTabId);
  return workspace.title ?? (activeTab ? tabTitle(activeTab) : "Workspace");
}

export function tabTitle(tab: Tab): string {
  // Claude Code prefixes its title with a status glyph (◐ ◑ while working,
  // ✳ when idle), and other programs do similar; our dot already says it.
  return tab.title.replace(/^\p{So}\s+/u, "") || "Terminal";
}

export const STATUS_LABELS: Record<AgentStatus, string> = {
  waiting: "Needs you",
  done: "Done",
  working: "Working",
  idle: "Idle",
};

export const statusColors: Record<AgentStatus, string> = {
  waiting: colors.orange(),
  done: colors.green(),
  working: colors.blue(),
  idle: colors.mediumGray(),
};
