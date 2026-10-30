// Handoff between Miks on a Mac and the iOS app: each advertises the tab on
// screen, so the other device offers to pick it up (the app switcher's banner
// on an iPhone, a badged Dock icon on a Mac). There's no router here, so "the
// page" is a path naming the Mac and tab, which the iOS shell's Handoff.swift
// carries as it does any chatwing app's path. A Mac is known to other devices
// by its gateway, so a Mac without tailnet access advertises nothing.
import { HostContext } from "crosswing/host/context";
import type { DaemonState } from "miks/shared/protocol";
import { use, useEffect, useRef } from "react";
import { daemon } from "./daemon";

/** The host another device reaches this state's Mac at, as webBridge knows it. */
function macHost(state: DaemonState | null): string | null {
  const gateway = state?.gateway;
  return gateway && "url" in gateway ? new URL(gateway.url).host : null;
}

function open(link: string, state: DaemonState | null) {
  const params = new URL(link, "https://miks").searchParams;
  const mac = params.get("mac");
  const tabId = params.get("tab");
  if (!mac || !tabId) return;

  // The iOS app, which can switch Macs on the way to a tapped notification's tab.
  const openInApp = (window as any).miks_openNotification;
  if (openInApp) return openInApp({ mac, tabId });

  // Every Mac window hears, and the one showing that Mac answers.
  if (mac !== macHost(state)) return;
  const workspace = state?.workspaces.find((w) => w.tabs.some((tab) => tab.id === tabId));
  if (!workspace) return;
  daemon.send({ type: "select", workspaceId: workspace.id, tabId });
  window.miks?.focus();
}

export function useHandoff(state: DaemonState | null) {
  const { deepLink } = use(HostContext);

  const stateRef = useRef(state);
  stateRef.current = state;

  const mac = macHost(state);
  const tabId = state?.workspaces.find((w) => w.id === state.activeWorkspaceId)?.activeTabId;
  const path = mac && tabId ? `/?${new URLSearchParams({ mac, tab: tabId })}` : null;

  // Only the window in front speaks: a Mac has one activity, however many windows.
  useEffect(() => {
    const advertise = () => {
      if (document.hasFocus()) window.miks?.handoff?.(path);
    };
    advertise();
    window.addEventListener("focus", advertise);
    return () => window.removeEventListener("focus", advertise);
  }, [path]);

  // From another device: the iOS app's deep link, or the Mac app's message.
  useEffect(() => {
    const link = deepLink.peek();
    if (link) open(deepLink.consume()!, stateRef.current);
  }, [deepLink]);

  const loaded = !!state;
  useEffect(() => {
    if (!loaded) return;
    const pending = window.miks?.takeHandoff?.();
    if (pending) open(pending, stateRef.current);
    return window.miks?.onHandoff?.((link) => open(link, stateRef.current));
  }, [loaded]);
}
