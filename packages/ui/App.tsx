import { colors } from "crosswing/colors";
import { Button } from "crosswing/components/Button";
import { PanelLayout } from "crosswing/components/PanelLayout";
import { fonts } from "crosswing/fonts";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { useDialog } from "crosswing/modals/dialog";
import { type AgentStatus, type DaemonState, PROTOCOL_VERSION } from "miks/shared/protocol";
import { DEFAULT_SETTINGS } from "miks/shared/settings";
import { easing } from "crosswing/shared/easing";
import { ChevronRight, Moon } from "lucide-react";
import { use, useEffect, useRef, useState } from "react";
import { keyframes, styled } from "styled-components";
import { HostContext } from "crosswing/host/context";
import { coarsePointer } from "crosswing/host/pointer";
import { provideSafeArea, safeArea } from "crosswing/safearea";
import { ChatLayout, hasPanel, isChatOpen, setChatOpen, toggleChat, toggleExpanded } from "./ChatPanel";
import { closeTab, closeWorkspace } from "./closing";
import { daemon, type Target, useDaemon, useMacs, useTarget } from "./daemon";
import { renderMarkdown } from "./markdown";
import { getSettings, setFontSize, updateSettings, useSettings } from "./settings";
import { Sidebar } from "./Sidebar";
import { workspaceTitle } from "./status";
import { StyledTabBar, TabBar } from "./TabBar";
import { StatusDot } from "./StatusDot";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog";
import { KeyBar } from "./KeyBar";
import { MacChooser, Ring, STATUS_LABELS } from "./MacChooser";
import {
  clearActiveTerminal,
  selectLastCommand,
  TERMINAL_BACKGROUND,
  TerminalView,
} from "./TerminalView";

/** A reply at least this long opens the chat panel, if that's on. */
const LONG_REPLY_LINES = 20;

/** In Miks's own window, whose traffic lights sit over the page; not in a browser. */
const HAS_WINDOW_BUTTONS = navigator.userAgent.includes("Electron");

export function App() {
  const { state, connected, error, retrying } = useDaemon();
  const { sidebarVisible } = useSettings();
  const target = useTarget();
  const macs = useMacs();
  const { stuck, retry } = useStuck(!connected && retrying);

  // Above the on-screen keyboard, in the iOS app, which says where its top is.
  const { viewport } = use(HostContext);
  const keyboardStyle = viewport.keyboardVisible && viewport.height ? { bottom: "auto", height: viewport.height } : undefined;

  const settingsTab = useRef<SettingsTab>("general");
  const settingsDialog = useDialog(() => (
    <SettingsDialog initialTab={settingsTab.current} onClose={settingsDialog.hide} />
  ));

  useEffect(() => {
    const handle = (command: string) => {
      if (command === "settings" || command === "settingsRemotes") {
        settingsTab.current = command === "settings" ? "general" : "remotes";
        return settingsDialog.show();
      }
      runCommand(command);
    };

    // In development, `window.miksCommand("newTab")` runs a menu command, for
    // checking them from DevTools (menu shortcuts can't be sent from there).
    if (import.meta.env.DEV) (window as any).miksCommand = handle;

    return daemon.onCommand(handle);
  }, [settingsDialog]);
  useSeenTracking(state);
  useAppearanceReporting(connected);
  useAgentNotifications(state);
  useLongReplyOpening(state);

  // Coming back to a dropped connection (a phone that slept), the last
  // screen stays up while it reconnects; the terminals attach again then.
  const reconnecting = !connected && !!state && retrying;

  if (!state || (!connected && !reconnecting)) {
    return (
      <StyledApp style={keyboardStyle}>
        {window.miks?.macs ? (
          <MacChooser />
        ) : (
          <div className="message">
            <div className="titlebar" />
            {target && <MachineBadge target={target} />}
            <p>{error ?? (target ? `Connecting to ${target.name}…` : "Connecting to the daemon…")}</p>
            {error && !retrying && (
              <button onClick={() => daemon.reconnect()}>{target ? "Try again" : "Start the daemon"}</button>
            )}
          </div>
        )}
      </StyledApp>
    );
  }

  const activeWorkspace = state.workspaces.find((w) => w.id === state.activeWorkspaceId) ?? null;

  return (
    <StyledApp style={keyboardStyle} data-stale={reconnecting && (stuck ? "stuck" : "true")}>
      <PanelLayout
        className="layout"
        edge="left"
        // Beside the terminals, unless that leaves them narrower than
        // contentMinSize (a phone held upright, a narrow window): then over
        // them, and a tap outside hides it.
        mode="auto"
        panelVisible={sidebarVisible}
        onPanelVisibleChange={(visible) => updateSettings({ sidebarVisible: visible })}
        panelDefaultSize={230}
        // Room for the traffic lights, which sit over the sidebar's top.
        panelMinSize={180}
        panelMaxSize={480}
        contentMinSize={320}
        // ⌘B is a menu item; a hotkey here would never see it past the terminal.
        hotkey={null}
        hideToolbarButton
        hideDragHandle
        restorationKey={Sidebar}
      >
        <div
          className="main"
          data-sidebar-visible={sidebarVisible}
          data-window-buttons={HAS_WINDOW_BUTTONS}
          data-remote={!!target}
        >
          {target && <MachineBadge target={target} />}
          {(state.protocol ?? 1) !== PROTOCOL_VERSION && (
            <div className="version-warning">
              {target ? target.name : "The daemon"} is running a different version of Miks. Update both to the same one;
              until then, some things may not work.
            </div>
          )}
          {activeWorkspace ? <TabBar workspace={activeWorkspace} /> : <div className="empty-bar" />}
          <div className="terminals">
            {/* Every tab's terminal stays mounted, so switching is instant. */}
            {state.workspaces.flatMap((workspace) =>
              workspace.tabs.map((tab) => {
                const active = workspace.id === state.activeWorkspaceId && tab.id === workspace.activeTabId;
                return (
                  <ChatLayout key={tab.id} tab={tab} active={active} supported={(state.protocol ?? 1) >= 5}>
                    <TerminalView tabId={tab.id} active={active} />
                  </ChatLayout>
                );
              }),
            )}
            {!activeWorkspace && (
              <div className="empty">
                {/* Only for a daemon from before it replaced the last workspace itself. */}
                <Button newStyle bordered onClick={() => daemon.send({ type: "createWorkspace" })} children="New workspace" />
              </div>
            )}
          </div>
        </div>
        <Sidebar workspaces={state.workspaces} activeWorkspaceId={state.activeWorkspaceId} home={state.home} />
      </PanelLayout>
      <KeyBar />
      {reconnecting && (
        <Reconnecting
          name={macs.find((mac) => mac.active)?.name ?? target?.name ?? null}
          error={error}
          stuck={stuck}
          onRetry={retry}
        />
      )}
    </StyledApp>
  );
}

export const StyledApp = styled.div`
  position: fixed;
  inset: 0;
  display: flex;
  /* The key bar, if any, under it all, on the on-screen keyboard. */
  flex-flow: column;
  background: ${colors.textBackground()};
  color: ${colors.text()};
  font: ${fonts.display({ size: 13 })};

  > .layout {
    flex-grow: 1;
    min-width: 0;
    min-height: 0;
    transition:
      opacity 0.2s,
      filter 0.2s;
  }

  /* Reconnecting: the last screen, faded, after a moment (a quick one never shows). */
  &[data-stale="true"] > .layout {
    opacity: 0.6;
    filter: saturate(0.4);
    transition-delay: 0.5s;
  }

  &[data-stale="stuck"] > .layout {
    opacity: 0.35;
    filter: saturate(0.2);
  }

  .main {
    display: flex;
    flex-flow: column;
    position: relative;

    /* Room for the badge, top right. */
    &[data-remote="true"] > ${StyledTabBar}, &[data-remote="true"] > .empty-bar {
      padding-right: 120px;
    }

    > .version-warning {
      order: 1;
      padding: 6px 12px;
      font: ${fonts.display({ size: 12 })};
      background: ${colors.yellow({ alpha: 0.2 })};
      border-bottom: 1px solid ${colors.separator()};
    }

    > ${StyledTabBar}, > .empty-bar {
      order: 0;
    }

    > .terminals {
      order: 2;
    }

    /* With the sidebar hidden, the traffic lights sit over the tab bar. */
    &[data-sidebar-visible="false"][data-window-buttons="true"] > ${StyledTabBar},
    &[data-sidebar-visible="false"][data-window-buttons="true"] > .empty-bar {
      padding-left: 80px;
    }

    > .empty-bar {
      height: 38px;
      padding-top: ${safeArea.top()};
      ${coarsePointer(`height: 48px;`)}
      -webkit-app-region: drag;
    }

    > .terminals {
      flex-grow: 1;
      position: relative;
      overflow: hidden;
      /* The tab bar is above. */
      ${provideSafeArea({ top: "0px" })}
      /* Matches the terminal themes, so the padding around them blends in. */
      background: ${TERMINAL_BACKGROUND.light};

      @media (prefers-color-scheme: dark) {
        background: ${TERMINAL_BACKGROUND.dark};
      }

      > .empty {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
    }
  }

  > .message {
    flex-grow: 1;
    display: flex;
    flex-flow: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: ${colors.textSecondary()};

    > .titlebar {
      position: absolute;
      inset: 0 0 auto 0;
      height: 44px;
      -webkit-app-region: drag;
    }

  }

  button {
    font: inherit;
  }
`;

/** How long reconnecting goes on before it's a Mac that isn't answering. */
const STUCK_DELAY = 8000;

/**
 * Whether reconnecting has gone on past STUCK_DELAY, counting from the page
 * showing again (a phone's timers stop while the app's away), and a retry
 * that counts from now.
 */
function useStuck(reconnecting: boolean) {
  const [stuck, setStuck] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setStuck(false);
    if (!reconnecting) return;
    let timer = setTimeout(() => setStuck(true), STUCK_DELAY);
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      setStuck(false);
      timer = setTimeout(() => setStuck(true), STUCK_DELAY);
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [reconnecting, attempt]);

  const retry = () => {
    setAttempt((count) => count + 1);
    daemon.reconnect();
  };

  return { stuck, retry };
}

/**
 * Over the last screen while it reconnects: a pill saying so, then, if the
 * Mac doesn't answer, a sheet to try again or (in the iOS app) open another.
 * Not for this Mac's own daemon, which a window waits on only while it
 * restarts.
 */
function Reconnecting({
  name,
  error,
  stuck,
  onRetry,
}: {
  name: string | null;
  error: string | null;
  stuck: boolean;
  onRetry: () => void;
}) {
  const bridge = window.miks?.macs;
  const others = useMacs().filter((mac) => !mac.active);

  if (!stuck || !name) {
    return (
      <StyledReconnecting>
        <div className="pill">
          <Ring />
          {name ? `Reconnecting to ${name}` : (error ?? "Reconnecting…")}
        </div>
      </StyledReconnecting>
    );
  }

  return (
    <StyledReconnecting>
      <div className="sheet">
        <div className="icon">
          <Moon />
        </div>
        <h2>{name} isn't answering</h2>
        <p>
          It may be asleep, or off {bridge ? "Tailscale" : "the network"}. Miks keeps trying, and picks up where you
          left off.
        </p>
        <Button newStyle primary onClick={onRetry} children="Try again" />
        {bridge && others.length > 0 && (
          <div className="others">
            <div className="heading">Or open</div>
            {others.map((mac) => (
              <button key={mac.host} onClick={() => bridge.select(mac.host)}>
                {mac.status ? <StatusDot status={mac.status} /> : <span className="dot" />}
                <span className="name">{mac.name}</span>
                <span className="detail">
                  {mac.status ? STATUS_LABELS[mac.status] : mac.connected ? "" : "Not answering"}
                </span>
                <ChevronRight />
              </button>
            ))}
          </div>
        )}
      </div>
    </StyledReconnecting>
  );
}

const fadeIn = keyframes`
  from {
    opacity: 0;
  }
`;

const rise = keyframes`
  from {
    transform: translateY(40px);
    opacity: 0;
  }
`;

const StyledReconnecting = styled.div`
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 20;

  > .pill {
    position: absolute;
    top: calc(${safeArea.top()} + 56px);
    left: 50%;
    transform: translateX(-50%);
    height: 40px;
    padding: 0 16px 0 12px;
    border-radius: 20px;
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    white-space: nowrap;
    background: ${colors.textBackground()};
    box-shadow:
      0 6px 24px rgba(0, 0, 0, 0.25),
      inset 0 0 0 1px ${colors.separator()};
    font: ${fonts.displayMedium({ size: 14 })};
    animation: ${fadeIn} 0.2s 0.5s both;

    > ${Ring} {
      width: 16px;
      height: 16px;
    }
  }

  > .sheet {
    pointer-events: auto;
    position: absolute;
    left: 12px;
    right: 12px;
    bottom: calc(${safeArea.bottom()} + 12px);
    max-width: 420px;
    margin: 0 auto;
    padding: 24px 20px 20px;
    border-radius: 28px;
    box-sizing: border-box;
    display: flex;
    flex-flow: column;
    gap: 10px;
    text-align: center;
    background: ${colors.textBackground()};
    box-shadow:
      0 -10px 40px rgba(0, 0, 0, 0.3),
      inset 0 0 0 1px ${colors.separator()};
    animation: ${rise} 0.3s ${easing.outQuint};

    > .icon {
      align-self: center;
      width: 52px;
      height: 52px;
      border-radius: 26px;
      background: ${colors.buttonBackgroundHover()};
      color: ${colors.textSecondary()};
      display: flex;
      align-items: center;
      justify-content: center;

      > svg {
        width: 26px;
        height: 26px;
      }
    }

    > h2 {
      margin: 0;
      font: ${fonts.displayBold({ size: 20, line: "26px" })};
    }

    > p {
      margin: 0 0 8px;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 15, line: "21px" })};
    }

    > .others {
      margin-top: 8px;
      padding-top: 12px;
      border-top: 1px solid ${colors.separator()};
      display: flex;
      flex-flow: column;
      text-align: left;

      > .heading {
        color: ${colors.textSecondary()};
        font: ${fonts.displayBold({ size: 12 })};
        letter-spacing: 0.6px;
        text-transform: uppercase;
      }

      > button {
        min-height: 48px;
        padding: 0 4px;
        border: none;
        background: transparent;
        color: ${colors.text()};
        display: flex;
        align-items: center;
        gap: 12px;

        > .dot {
          flex-shrink: 0;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          box-shadow: inset 0 0 0 1.5px ${colors.textSecondary()};
        }

        > .name {
          flex-grow: 1;
          text-align: left;
          font: ${fonts.display({ size: 17 })};
        }

        > .detail {
          color: ${colors.textSecondary()};
          font: ${fonts.display({ size: 14 })};
        }

        > svg {
          width: 16px;
          height: 16px;
          color: ${colors.textSecondary()};
        }
      }
    }
  }
`;

/**
 * Which Mac this window's terminals are on, top right, in the color you gave
 * it: a window on another Mac should never pass for this one.
 */
function MachineBadge({ target }: { target: Target }) {
  return (
    <StyledMachineBadge style={{ background: target.color }} title={`Terminals on ${target.host}, over SSH`}>
      {target.name}
    </StyledMachineBadge>
  );
}

const StyledMachineBadge = styled.div`
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 10;
  max-width: 110px;
  padding: 0 9px;
  height: 22px;
  line-height: 22px;
  border-radius: 11px;
  color: #fff;
  font: ${fonts.displayBold({ size: 12, line: "22px" })};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  -webkit-app-region: drag;
`;

/**
 * Menu commands. They read the state fresh each time, so the handler never
 * has to be resubscribed.
 */
function runCommand(command: string) {
  switch (command) {
    case "toggleSidebar":
      return updateSettings({ sidebarVisible: !getSettings().sidebarVisible });

    case "fontBigger":
      return setFontSize(getSettings().fontSize + 1);
    case "fontSmaller":
      return setFontSize(getSettings().fontSize - 1);
    case "fontReset":
      return setFontSize(DEFAULT_SETTINGS.fontSize);
    case "selectLastCommand":
      return selectLastCommand();
    case "clearToStart":
      return clearActiveTerminal();
  }

  const state = daemon.getSnapshot().state;
  if (!state) return;

  const workspaces = state.workspaces;
  const workspace = workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tabs = workspace?.tabs ?? [];
  const tabIndex = tabs.findIndex((tab) => tab.id === workspace?.activeTabId);
  const workspaceIndex = workspaces.findIndex((w) => w.id === workspace?.id);

  // On past a workspace's first or last tab, into the one before or after
  // it: every tab in sidebar order, round from the last to the first.
  const selectTab = (offset: number) => {
    const all = workspaces.flatMap((w) => w.tabs.map((tab) => ({ workspaceId: w.id, tabId: tab.id })));
    if (all.length === 0) return;
    const current = all.findIndex((entry) => entry.tabId === workspace?.activeTabId);
    daemon.send({ type: "select", ...all[(Math.max(current, 0) + offset + all.length) % all.length] });
  };

  const selectWorkspace = (index: number) => {
    const target = workspaces[index];
    if (target) daemon.send({ type: "select", workspaceId: target.id });
  };

  switch (command) {
    case "toggleChat": {
      // Only for a tab with something to show: Claude Code, a file or a page.
      const tab = tabs[tabIndex];
      if (tab && hasPanel(tab)) toggleChat(tab);
      return;
    }
    case "toggleExpanded": {
      const tab = tabs[tabIndex];
      if (tab && hasPanel(tab)) toggleExpanded(tab);
      return;
    }
    case "newTab":
      if (workspace) daemon.send({ type: "createTab", workspaceId: workspace.id });
      else daemon.send({ type: "createWorkspace" });
      return;
    case "newWorkspace":
      return daemon.send({ type: "createWorkspace" });
    case "closeTab": {
      const tab = tabs[tabIndex];
      if (tab) closeTab(tab);
      return;
    }
    case "closeWorkspace":
      if (workspace) closeWorkspace(workspace);
      return;
    case "nextTab":
      return selectTab(1);
    case "previousTab":
      return selectTab(-1);
    case "nextWorkspace":
      return selectWorkspace((workspaceIndex + 1) % workspaces.length);
    case "previousWorkspace":
      return selectWorkspace((workspaceIndex - 1 + workspaces.length) % workspaces.length);
  }

  const number = command.match(/^workspace(\d)$/)?.[1];
  if (number) selectWorkspace(Number(number) - 1);
}

/**
 * An agent's `done` means "finished, and you haven't looked yet". Selecting
 * the tab clears it in the daemon; this covers the other way of looking: the
 * tab was already on screen, in a focused window, when the agent finished.
 */
function useSeenTracking(state: DaemonState | null) {
  const workspace = state?.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tab = workspace?.tabs.find((t) => t.id === workspace.activeTabId);
  const doneTabId = tab?.agent?.status === "done" ? tab.id : null;

  useEffect(() => {
    if (!doneTabId) return;

    const markSeen = () => daemon.send({ type: "seen", tabId: doneTabId });
    if (document.hasFocus()) markSeen();

    window.addEventListener("focus", markSeen);
    return () => window.removeEventListener("focus", markSeen);
  }, [doneTabId]);
}

/**
 * Opens the chat panel when the tab you're looking at finishes a long reply,
 * which reads better there. Leaves the keyboard in the terminal.
 */
function useLongReplyOpening(state: DaemonState | null) {
  const { chatForLongReplies } = useSettings();
  const workspace = state?.workspaces.find((w) => w.id === state.activeWorkspaceId);
  const tab = workspace?.tabs.find((t) => t.id === workspace.activeTabId);
  const agent = tab?.agent;
  const longReply = agent?.status === "done" && (agent.replyLines ?? 0) >= LONG_REPLY_LINES ? `${tab?.id}:${agent.since}` : null;

  useEffect(() => {
    if (longReply && tab && chatForLongReplies && !isChatOpen(tab)) setChatOpen(tab, true);
  }, [longReply]);
}

/**
 * Tells the daemon whether we're light or dark, now and whenever it changes,
 * so programs that follow the terminal's color scheme (Claude Code, set to its
 * "auto" theme) switch with the system.
 */
function useAppearanceReporting(connected: boolean) {
  const dark = useMatchMedia("(prefers-color-scheme: dark)");

  useEffect(() => {
    if (!connected) return;
    const report = () => daemon.send({ type: "appearance", dark });
    report();
    // The window you're in decides, when the daemon has one on another Mac too.
    window.addEventListener("focus", report);
    return () => window.removeEventListener("focus", report);
  }, [connected, dark]);
}

/**
 * A notification when an agent finishes or needs you, unless you're already
 * looking at it. Only for changes seen while connected: the statuses a fresh
 * connection reports are old news.
 */
/** Markdown as the words it shows, a line per paragraph, item or heading: a notification's body is plain text. */
function plainText(markdown: string): string {
  const { body } = new DOMParser().parseFromString(renderMarkdown(markdown), "text/html");
  for (const block of body.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6, pre, tr")) block.append("\n");
  return (body.textContent ?? "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function useAgentNotifications(state: DaemonState | null) {
  const { notifications } = useSettings();
  const previous = useRef<Map<string, AgentStatus | undefined> | null>(null);

  useEffect(() => {
    if (!state) return;

    const statuses = new Map<string, AgentStatus | undefined>();
    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) statuses.set(tab.id, tab.agent?.status);
    }

    const before = previous.current;
    previous.current = statuses;
    // The iOS app's web view has no Notification, and throwing here took the whole page down.
    if (!before || !notifications || typeof Notification === "undefined") return;

    for (const workspace of state.workspaces) {
      for (const tab of workspace.tabs) {
        const status = tab.agent?.status;
        if (status !== "done" && status !== "waiting") continue;
        if (!before.has(tab.id) || before.get(tab.id) === status) continue;

        const onScreen = workspace.id === state.activeWorkspaceId && tab.id === workspace.activeTabId;
        if (onScreen && document.hasFocus()) continue;

        const notification = new Notification(workspaceTitle(workspace), {
          body:
            status === "waiting"
              ? (tab.agent?.message ?? "Needs your input")
              : (plainText(tab.agent?.reply ?? "") || "Done"),
          // One per tab: a newer status replaces an older one still showing.
          tag: tab.id,
        });
        notification.onclick = () => {
          window.miks?.focus();
          daemon.send({ type: "select", workspaceId: workspace.id, tabId: tab.id });
        };
      }
    }
  }, [state, notifications]);
}
