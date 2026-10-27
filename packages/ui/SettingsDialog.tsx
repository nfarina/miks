import { colors } from "crosswing/colors";
import { Button } from "crosswing/components/Button";
import { LabeledToggle } from "crosswing/components/forms/LabeledToggle";
import { Dropdown } from "crosswing/components/forms/Dropdown";
import { TextInput } from "crosswing/components/forms/TextInput";
import { TipView } from "crosswing/components/TipView";
import { useInputValue } from "crosswing/components/forms/useInputValue";
import { SeparatorLayout, StyledSeparatorLayout } from "crosswing/components/SeparatorLayout";
import { TabbedButton, TabbedButtonLayout } from "crosswing/components/TabbedButtonLayout";
import { fonts } from "crosswing/fonts";
import { DialogView } from "crosswing/modals/dialog";
import { PopupMenu, PopupMenuSeparator, PopupMenuText } from "crosswing/components/PopupMenu";
import { usePopup } from "crosswing/modals/popup/usePopup";
import { Check, Minus, Monitor, Plus, ShieldAlert, X } from "lucide-react";
import type { Permission } from "miks/shared/protocol";
import type { KeepAvailable, Remote } from "miks/shared/settings";
import type { TailnetMac } from "miks/shared/tailscale";
import { styled } from "styled-components";
import { useEffect, useState } from "react";
import { daemon, type PermissionsEvent, useDaemon, useTarget } from "./daemon";
import { DEVICE_SETTINGS, setFontSize, updateSettings, useSettings } from "./settings";
import { focusActiveTerminal } from "./TerminalView";

export type SettingsTab = "general" | "remotes" | "permissions" | "advanced";

/**
 * Settings (⌘,). Changes apply as you make them, like the rest of macOS;
 * there's nothing to save.
 */
export function SettingsDialog({ initialTab = "general", onClose }: { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);

  // The terminal keeps the keyboard unless we take it: typing would land in
  // the shell behind the dialog, and Escape wouldn't close it. However it
  // closes (Escape, a click outside, the button), the keyboard goes back.
  useEffect(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    return () => focusActiveTerminal();
  }, []);

  const target = useTarget();

  return (
    <DialogView title="Settings" onClose={onClose} form={false}>
      {/* This window is on another Mac, but its window, keys and notifications are this one's. */}
      {target && tab !== "permissions" && <StyledNote>Settings for this Mac. {target.name}'s are in Miks there.</StyledNote>}
      {DEVICE_SETTINGS && tab !== "permissions" && <StyledNote>Settings for this device. Your Macs' are in Miks there.</StyledNote>}
      <StyledSettings layout="grow" pad={false} value={tab} onValueChange={setTab}>
        <TabbedButton title="General" value="general">
          <GeneralSettings />
        </TabbedButton>
        {/* Windows on other Macs, and this one for your other devices: the Mac app's. */}
        {!DEVICE_SETTINGS && (
          <TabbedButton title="Remotes" value="remotes">
            <RemoteSettings />
          </TabbedButton>
        )}
        <TabbedButton title="Permissions" value="permissions">
          <PermissionSettings />
        </TabbedButton>
        <TabbedButton title="Advanced" value="advanced">
          <AdvancedSettings />
        </TabbedButton>
      </StyledSettings>
    </DialogView>
  );
}

function GeneralSettings() {
  const settings = useSettings();

  return (
    <SeparatorLayout bordered>
      <TextSize />
      {!DEVICE_SETTINGS && (
        <LabeledToggle
          label="Notifications"
          detail="When an agent finishes or needs you, unless you're looking at it."
          on={settings.notifications}
          onClick={() => updateSettings({ notifications: !settings.notifications })}
        />
      )}
      <LabeledToggle
        label="Open chat for long replies"
        detail="When Claude finishes a reply of 20 lines or more in the tab you're looking at, the chat panel (⌘⇧C) opens to show it."
        on={settings.chatForLongReplies}
        onClick={() => updateSettings({ chatForLongReplies: !settings.chatForLongReplies })}
      />
      {/* What the Mac app does on its Mac. */}
      {!DEVICE_SETTINGS && <MacSettings />}
    </SeparatorLayout>
  );
}

function MacSettings() {
  const settings = useSettings();

  return (
    <>
      <LabeledToggle
        label="Claude Code status"
        detail="Adds hooks to ~/.claude/settings.json that tell Miks what Claude is up to. Outside Miks they do nothing."
        on={settings.claudeHooks}
        onClick={() => updateSettings({ claudeHooks: !settings.claudeHooks })}
      />
      <LabeledToggle
        label="Keep terminals running"
        detail="After Miks quits, so they're all still there when it opens again."
        on={settings.keepDaemonRunning}
        onClick={() => updateSettings({ keepDaemonRunning: !settings.keepDaemonRunning })}
      />
      <div className="field">
        <div className="content">
          <div className="label">Open links in</div>
          <div className="detail">Links clicked in terminals and chat, and pages' links that open a new window.</div>
        </div>
        <BrowserSelect />
      </div>
    </>
  );
}

/** The terminals' and chat's text size, as ⌘+ and ⌘− set it. */
function TextSize() {
  const { fontSize } = useSettings();

  return (
    <div className="field">
      <div className="content">
        <div className="label">Text size</div>
        <div className="detail">In terminals and chat.{!DEVICE_SETTINGS && " Also ⌘+ and ⌘−, and ⌘0 to reset."}</div>
      </div>
      <div className="stepper">
        <button onClick={() => setFontSize(fontSize - 1)} aria-label="Smaller text">
          <Minus />
        </button>
        <span>{fontSize}</span>
        <button onClick={() => setFontSize(fontSize + 1)} aria-label="Bigger text">
          <Plus />
        </button>
      </div>
    </div>
  );
}

const BROWSERS = [
  { value: "", children: "Default browser" },
  { value: "com.apple.Safari", children: "Safari" },
  { value: "com.google.Chrome", children: "Chrome" },
];

/** The default browser, a common one, or any app (kept by its path). */
function BrowserSelect() {
  const { browser } = useSettings();
  const chosen = browser.startsWith("/") ? browser : null;

  async function onValueChange(value: string) {
    if (value !== "choose") return updateSettings({ browser: value });
    const path = await window.miks?.chooseBrowser();
    if (path) updateSettings({ browser: path });
  }

  return (
    <Dropdown
      bordered
      className="browser"
      value={browser}
      onValueChange={onValueChange}
      items={[
        ...BROWSERS,
        ...(chosen ? [{ value: chosen, children: chosen.split("/").pop()!.replace(/\.app$/, "") }] : []),
        { value: "choose", children: "Choose app…" },
      ]}
    />
  );
}

function AdvancedSettings() {
  const settings = useSettings();
  const pathPrefix = useInputValue({
    initialValue: settings.hidePathPrefix || null,
    onValueChange: (_value, text) => updateSettings({ hidePathPrefix: text }),
  });

  return (
    <SeparatorLayout bordered>
      <LabeledToggle
        label="Option as Meta"
        detail="⌥ with a key sends Escape and the key, as shell shortcuts expect, instead of typing a character like å."
        on={settings.optionAsMeta}
        onClick={() => updateSettings({ optionAsMeta: !settings.optionAsMeta })}
      />
      {/* Laid out like the toggle above it, with the field where a switch is. */}
      <label className="field">
        <div className="content">
          <div className="label">Hide path prefix</div>
          <div className="detail">
            Left off directories in the sidebar, so ~/Code/sage shows as sage. Kept on the Mac, for every window and device on it.
          </div>
        </div>
        <TextInput newStyle placeholder="~/Code/" {...pathPrefix.props} />
      </label>
    </SeparatorLayout>
  );
}

/**
 * What programs in the window's daemon's terminals may do, on its Mac (so
 * another Mac's, in a remote window), and a way to ask for each ahead of
 * time, so a program never sits waiting on a dialog nobody's there for.
 */
function PermissionSettings() {
  const target = useTarget();
  const { connected, state } = useDaemon();
  const [answer, setAnswer] = useState<PermissionsEvent | null>(null);

  // Again every 2s, for switches flipped in System Settings.
  useEffect(() => {
    const unsubscribe = daemon.onPermissions(setAnswer);
    const check = () => daemon.send({ type: "permissions" });
    check();
    const timer = setInterval(check, 2000);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [connected]);

  const app = answer?.app ?? "Miks";
  const where = target ? `${target.name}'s` : "this Mac's";
  const request = (id: string) => daemon.send({ type: "requestPermission", id });
  const unasked = (answer?.permissions ?? []).filter(
    (item) => item.kind === "ask" && (item.status === "notAsked" || item.status === "unknown") && !item.asking,
  );

  if (state && (state.protocol ?? 1) < 7) {
    return (
      <StyledPermissions>
        <p className="intro">{target ? `${target.name}'s Miks` : "This daemon"} is too old to say. Update Miks there.</p>
      </StyledPermissions>
    );
  }

  return (
    <StyledPermissions>
      <p className="intro">
        To macOS, every program in {where} terminals is {app}, and it asks the first time one needs something here, in a
        dialog{target ? ` on ${target.name}'s screen` : ""}. Ask ahead, and nothing's left waiting on one while you're
        away.
      </p>
      {unasked.length > 0 && (
        <Button newStyle bordered className="all" onClick={() => unasked.forEach((item) => request(item.id))}>
          Ask for all {unasked.length}
        </Button>
      )}
      {answer && (
        <SeparatorLayout bordered>
          {answer.permissions.map((item) => (
            <div className="field" key={item.id}>
              <div className="content">
                <div className="label">{item.name}</div>
                {item.detail && <div className="detail">{item.detail}</div>}
              </div>
              <PermissionAction item={item} onRequest={() => request(item.id)} />
            </div>
          ))}
        </SeparatorLayout>
      )}
    </StyledPermissions>
  );
}

function PermissionAction({ item, onRequest }: { item: Permission; onRequest: () => void }) {
  if (item.asking) return <div className="status">Asking…</div>;
  if (item.status === "granted") {
    return (
      <div className="status granted">
        <Check /> Allowed
      </div>
    );
  }
  // Turned down once, macOS won't ask again: it's a switch in System Settings now.
  const settings = item.kind === "settings" || item.status === "denied";
  return (
    <div className="status">
      {item.status === "denied" && item.kind === "ask" && "Denied"}
      <Button newStyle bordered onClick={onRequest} children={settings ? "Open Settings" : "Ask"} />
    </div>
  );
}

const StyledPermissions = styled.div`
  display: flex;
  flex-flow: column;
  gap: 12px;

  > .intro {
    margin: 0;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13, line: "18px" })};
  }

  > .all {
    align-self: flex-start;
  }

  .field > .status {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    width: auto;
    min-width: 130px;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13, line: "18px" })};

    &.granted {
      color: #22a06b;
      gap: 4px;

      > svg {
        width: 15px;
        height: 15px;
      }
    }
  }
`;

/** Badge colors, picked in turn for each Mac added, and by clicking the swatch. */
const REMOTE_COLORS = ["#3b82f6", "#e5734a", "#22a06b", "#9b5de5", "#d4a20b", "#e0567a"];

/**
 * The other way around: the window's Mac's terminals, from your other
 * devices on Tailscale (an iPad, a phone), and whether it stays available to
 * them while you're away. The settings are that Mac's (`machine.json`), so a
 * window on another Mac changes that one's, if its Miks is new enough.
 */
function TailnetAccess() {
  const { tailnetAccess, keepAvailable } = useSettings();
  const { state } = useDaemon();
  const target = useTarget();
  if (target && !state?.machine) return null;
  const gateway = state?.gateway;
  const keeper = state?.keeper;

  return (
    <>
      <h3 className="heading">{target ? `Access ${target.name} from elsewhere` : "Access this Mac from elsewhere"}</h3>
      <SeparatorLayout bordered>
        <LabeledToggle
          label="Access from your other devices"
          detail="Your other Macs (in Miks), iPad or phone (in the app or a browser) can use Miks here, over Tailscale: only devices signed in to Tailscale as you, never anything else on the network."
          on={tailnetAccess}
          onClick={() => updateSettings({ tailnetAccess: !tailnetAccess })}
        />
        {tailnetAccess && gateway && (
          <p className="gateway">
            {"url" in gateway ? (
              <>
                Open <code>{gateway.url}</code> on them.
              </>
            ) : (
              gateway.error
            )}
          </p>
        )}
        {state?.machine && "keepAvailable" in state.machine && (
          <div className="field">
            <div className="content">
              <div className="label">While you're away</div>
              <div className="detail">{KEEP_AVAILABLE_DETAIL[keepAvailable]}</div>
            </div>
            <Dropdown
              bordered
              className="keep-available"
              value={keepAvailable}
              onValueChange={(value) => updateSettings({ keepAvailable: value as KeepAvailable })}
              items={[
                { value: "off", children: "Sleep" },
                { value: "locked", children: "Stay awake, locked" },
                { value: "unlocked", children: "Stay awake, self-locked" },
              ]}
            />
          </div>
        )}
      </SeparatorLayout>
      {keepAvailable === "unlocked" && (
        <TipView icon={<ShieldAlert />} title="Miks guards it, not the lock screen">
          The screen goes dark and its keyboard and trackpad do nothing until you use Touch ID or your password. But
          macOS never locks it, which is how agents can use the screen: the session stays open, so anything that
          reaches Miks can use it as you. Unplugged, it locks for real; with the lid closed, it sleeps.
        </TipView>
      )}
      {keepAvailable === "unlocked" && keeper && keeper.accessibility && !keeper.plugged && (
        <TipView title="On battery now">
          So it sleeps and locks as usual (⌃⌘Q too), until it's plugged in again.
        </TipView>
      )}
      {keepAvailable === "unlocked" && keeper && !keeper.accessibility && (
        <TipView title="Needs Accessibility">
          To hold its keyboard and trackpad. Until you allow it (Permissions), it locks as usual.
        </TipView>
      )}
    </>
  );
}

/** What each choice for while you're away does. */
const KEEP_AVAILABLE_DETAIL: Record<KeepAvailable, string> = {
  off: "It sleeps as usual, out of reach until it wakes.",
  locked: "Plugged in with the lid open, it stays awake, and locks as usual. Agents can still use terminals and Chrome.",
  unlocked: "Plugged in with the lid open, it stays awake, locked by Miks instead of macOS, so agents can use its screen too.",
};

function RemoteSettings() {
  const { remotes } = useSettings();
  const setRemotes = (next: Remote[]) => updateSettings({ remotes: next });
  const change = (id: string, changes: Partial<Remote>) =>
    setRemotes(remotes.map((remote) => (remote.id === id ? { ...remote, ...changes } : remote)));

  const add = (host = "") =>
    setRemotes([
      ...remotes,
      {
        id: crypto.randomUUID().slice(0, 8),
        name: host,
        host,
        color: REMOTE_COLORS[remotes.length % REMOTE_COLORS.length],
      },
    ]);

  // The Macs on your tailnet, to add one by picking it.
  const menu = usePopup((found: { macs?: TailnetMac[]; error?: string }) => {
    const added = new Set(remotes.map((remote) => remote.host.toLowerCase()));
    const macs = (found.macs ?? []).filter((mac) => mac.mine && !added.has(mac.name.toLowerCase()));
    return (
      <PopupMenu>
        {found.error && <PopupMenuText disabled children={found.error} />}
        {macs.map((mac) => (
          <PopupMenuText
            key={mac.name}
            icon={<Monitor />}
            onClick={() => add(mac.name)}
            detail={mac.online ? undefined : "Offline"}
            children={mac.name}
          />
        ))}
        {!found.error && macs.length === 0 && <PopupMenuText disabled children="No other Macs of yours on Tailscale" />}
        <PopupMenuSeparator />
        <PopupMenuText onClick={() => add()} children="Another…" />
      </PopupMenu>
    );
  });

  return (
    <StyledRemotes>
      <h3 className="heading">Access other Macs</h3>
      <p className="intro">
        A window on another Mac's terminals, as if you were there. It connects over Tailscale, so that Mac needs Miks
        running, with Access from your other devices (below, on that Mac) on. Open one here, or from the Remotes menu
        (⌃⌥⌘1, ⌃⌥⌘2…).
      </p>
      {remotes.length > 0 && (
        <SeparatorLayout bordered>
          {remotes.map((remote) => (
            <div className="remote" key={remote.id}>
              <button
                className="swatch"
                style={{ background: remote.color }}
                title="Change color"
                onClick={() => {
                  const next = (REMOTE_COLORS.indexOf(remote.color) + 1) % REMOTE_COLORS.length;
                  change(remote.id, { color: REMOTE_COLORS[next] });
                }}
              />
              <TextInput
                newStyle
                className="name"
                placeholder="Name"
                value={remote.name}
                onValueChange={(name) => change(remote.id, { name })}
              />
              <TextInput
                newStyle
                className="host"
                placeholder="Name on Tailscale"
                value={remote.host}
                onValueChange={(host) => change(remote.id, { host })}
              />
              <Button newStyle
                className="open"
                disabled={!remote.name || !remote.host}
                onClick={() => window.miks?.openRemote(remote.id)}
                children="Open"
              />
              <button
                className="remove"
                title="Remove"
                onClick={() => setRemotes(remotes.filter((r) => r.id !== remote.id))}
              >
                <X />
              </button>
            </div>
          ))}
        </SeparatorLayout>
      )}
      <Button
        newStyle
        bordered
        className="add"
        icon={<Plus />}
        onClick={async (event) => {
          const target = { current: event.currentTarget };
          menu.show(target, (await window.miks?.tailnetMacs?.()) ?? { error: "Update Miks to list your Macs." });
        }}
        children="Add a Mac"
      />
      <TailnetAccess />
    </StyledRemotes>
  );
}

const StyledRemotes = styled.div`
  display: flex;
  flex-flow: column;
  gap: 12px;

  > .heading {
    margin: 12px 0 0;
    font: ${fonts.displayBold({ size: 13, line: "18px" })};
    color: ${colors.text()};

    &:first-child {
      margin-top: 0;
    }
  }

  > .intro,
  .gateway {
    margin: 0;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 13, line: "18px" })};

    > code {
      font-size: 12px;
      user-select: text;
    }
  }

  .gateway {
    padding: 8px 10px;
  }

  .remote {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;

    > .swatch {
      flex-shrink: 0;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 50%;
      cursor: pointer;
    }

    > .name {
      width: 110px;
      flex-shrink: 0;
    }

    > .host {
      flex-grow: 1;
      min-width: 0;
    }

    > .remove {
      display: flex;
      flex-shrink: 0;
      padding: 4px;
      border: none;
      background: transparent;
      color: ${colors.textSecondary()};
      cursor: pointer;

      > svg {
        width: 15px;
        height: 15px;
      }
    }
  }

  > .add {
    align-self: flex-start;
  }
`;

const StyledNote = styled.p`
  margin: 0 0 12px;
  color: ${colors.textSecondary()};
  font: ${fonts.display({ size: 13, line: "18px" })};
`;

const StyledSettings = styled(TabbedButtonLayout)`
  width: 520px;
  max-width: 100%;

  /* Each tab's content, clear of the tabs. */
  ${StyledRemotes}, ${StyledPermissions}, ${StyledSeparatorLayout}:not(${StyledRemotes} *):not(${StyledPermissions} *) {
    margin-top: 16px;
  }

  .field {
    display: flex;
    align-items: center;
    gap: 20px;
    min-height: 50px;
    padding: 7px 10px;
    box-sizing: border-box;

    > .content {
      flex-grow: 1;
      display: flex;
      flex-flow: column;

      > .label {
        font: ${fonts.displayBold({ size: 14, line: "20px" })};
        color: ${colors.text()};
      }

      > .detail {
        font: ${fonts.display({ size: 14, line: "20px" })};
        color: ${colors.textSecondary()};
      }
    }

    > *:last-child {
      flex-shrink: 0;
      width: 130px;
    }

    > .browser,
    > .keep-available {
      width: auto;
      min-width: 130px;
    }

    > .stepper {
      display: flex;
      align-items: center;
      justify-content: space-between;
      height: 32px;
      border-radius: 8px;
      background: ${colors.buttonBackgroundGlow()};

      > span {
        font: ${fonts.displayMedium({ size: 14 })};
        font-variant-numeric: tabular-nums;
        color: ${colors.text()};
      }

      > button {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 100%;
        border: none;
        background: transparent;
        color: ${colors.text()};

        > svg {
          width: 16px;
          height: 16px;
        }
      }
    }
  }
`;
