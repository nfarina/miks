import { colors } from "crosswing/colors";
import { Button } from "crosswing/components/Button";
import { TextInput } from "crosswing/components/forms/TextInput";
import { PopupMenu, PopupMenuText } from "crosswing/components/PopupMenu";
import { fonts } from "crosswing/fonts";
import { useConfirm } from "crosswing/modals/confirm";
import { usePopup } from "crosswing/modals/popup/usePopup";
import { safeArea } from "crosswing/safearea";
import { Ellipsis, Laptop, Plus, Smartphone, Trash2 } from "lucide-react";
import { useState } from "react";
import { keyframes, styled } from "styled-components";
import { type Mac, useMacs } from "./daemon";
import { STATUS_LABELS, statusColors, URGENCY } from "./status";
import { StatusDot } from "./StatusDot";

/** How many of a Mac's workspaces its card lists. */
const CARD_WORKSPACES = 4;

let addingNext = false;

/** Shows the chooser's form for adding a Mac (the sidebar's Add a Mac…), rather than the Macs. */
export function addMac() {
  addingNext = true;
  window.miks?.macs?.select(null);
}

/**
 * In the iOS app, until one connects: the Macs you've added, as cards
 * saying what each one's agents are doing, or, with none yet (or from +),
 * how to add one, by its name ("air", which the app looks up) or the
 * address its Settings shows (Remotes → Access from your other devices).
 */
export function MacChooser() {
  const macs = useMacs();
  const [adding, setAdding] = useState(() => {
    const next = addingNext;
    addingNext = false;
    return next;
  });

  if (adding || macs.length === 0) return <AddMac onCancel={macs.length > 0 ? () => setAdding(false) : undefined} />;

  return (
    <StyledMacChooser>
      <header>
        <h1>Your Macs</h1>
        <button className="add" aria-label="Add a Mac" onClick={() => setAdding(true)}>
          <Plus />
        </button>
      </header>
      <div className="cards">
        {macs.map((mac) => (
          <MacCard key={mac.host} mac={mac} />
        ))}
      </div>
    </StyledMacChooser>
  );
}

function MacCard({ mac }: { mac: Mac }) {
  const bridge = window.miks!.macs!;
  const removing = useRemoveMac();
  const menu = usePopup(() => (
    <PopupMenu>
      <PopupMenuText
        destructive
        icon={<Trash2 />}
        onClick={() => removing.show(mac)}
        children={`Remove ${mac.name}…`}
      />
    </PopupMenu>
  ));

  const workspaces = mac.workspaces
    .filter((workspace) => workspace.status && workspace.status !== "idle")
    .sort((a, b) => URGENCY.indexOf(a.status!) - URGENCY.indexOf(b.status!))
    .slice(0, CARD_WORKSPACES);

  const detail = mac.active
    ? "Connecting…"
    : mac.connected
      ? `${mac.workspaces.length} ${mac.workspaces.length === 1 ? "workspace" : "workspaces"}`
      : mac.seen
        ? `Not answering · seen ${ago(mac.seen)}`
        : "Not answering";

  return (
    <StyledMacCard data-live={mac.active || mac.connected}>
      <div className="top">
        <div className="icon">
          <Laptop />
        </div>
        {/* Covers the whole card (its ::after), all but the menu button. Again with the one already chosen is a retry. */}
        <button className="pick" onClick={() => bridge.select(mac.host)}>
          <span className="name">{mac.name}</span>
          <span className="detail">
            {mac.active && <Ring />}
            {detail}
          </span>
        </button>
        <button className="more" aria-label={`${mac.name} options`} onClick={menu.onClick}>
          <Ellipsis />
        </button>
      </div>
      {workspaces.length > 0 && (
        <div className="workspaces">
          {workspaces.map((workspace, index) => (
            <div className="workspace" key={index}>
              <StatusDot status={workspace.status!} />
              <span className="title">{workspace.title}</span>
              <span className="status" data-status={workspace.status}>
                {STATUS_LABELS[workspace.status!]}
              </span>
            </div>
          ))}
        </div>
      )}
    </StyledMacCard>
  );
}

/** Asks before removing a Mac (its … menu's, or the sidebar's). */
export function useRemoveMac() {
  return useConfirm((mac: Mac) => ({
    title: `Remove ${mac.name}?`,
    message: "Its terminals keep running there. To open them here again, add it again.",
    destructiveText: "Remove",
    onConfirm: () => window.miks?.macs?.remove(mac.host),
  }));
}

function AddMac({ onCancel }: { onCancel?: () => void }) {
  const bridge = window.miks!.macs!;
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <StyledMacChooser data-adding>
      {onCancel && (
        <button className="cancel" onClick={onCancel}>
          Cancel
        </button>
      )}
      <div className="picture" aria-hidden="true">
        <Smartphone className="phone" />
        <div className="line">
          <div className="dot" />
        </div>
        <Laptop className="laptop" />
      </div>
      <div className="intro">
        <h1>Your terminals, here</h1>
        <p>Miks opens the sessions running on your Mac, over Tailscale.</p>
      </div>
      <ol className="steps">
        <li>
          <span className="number">1</span>
          <span>Sign in to Tailscale on both, with the same account.</span>
        </li>
        <li>
          <span className="number">2</span>
          <span>
            On the Mac, turn on Miks → Settings → Remotes → <b>Access from your other devices</b>.
          </span>
        </li>
        <li>
          <span className="number">3</span>
          <span>Type the Mac's name below.</span>
        </li>
      </ol>
      <div className="space" />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setAdding(true);
          setProblem(await bridge.add(text));
          setAdding(false);
        }}
      >
        <label htmlFor="mac-name">Mac's name</label>
        <TextInput
          newStyle
          id="mac-name"
          value={text}
          onValueChange={(value) => (setText(value), setProblem(null))}
          placeholder="air"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
        {problem && <p className="problem">{problem}</p>}
        <Button newStyle primary type="submit" working={adding} disabled={!text.trim()} children="Connect" />
      </form>
    </StyledMacChooser>
  );
}

/** "3 hours ago", roughly. */
function ago(time: number): string {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const spin = keyframes`
  to {
    transform: rotate(360deg);
  }
`;

/** A small spinning ring, in the text's color. */
export const Ring = styled.span`
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
  border-top-color: currentColor;
  animation: ${spin} 0.8s linear infinite;
`;

const travel = keyframes`
  0% { left: 0; opacity: 0; }
  20%, 80% { opacity: 1; }
  100% { left: calc(100% - 8px); opacity: 0; }
`;

const StyledMacChooser = styled.div`
  flex-grow: 1;
  align-self: stretch;
  overflow-y: auto;
  display: flex;
  flex-flow: column;
  gap: 20px;
  box-sizing: border-box;
  width: min(440px, 100%);
  margin: 0 auto;
  padding: calc(${safeArea.top()} + 28px) 20px calc(${safeArea.bottom()} + 20px);
  color: ${colors.text()};

  button {
    font: inherit;
    color: inherit;
  }

  h1 {
    margin: 0;
    font: ${fonts.displayBold({ size: 30, line: "36px" })};
    letter-spacing: -0.5px;
  }

  > header {
    display: flex;
    align-items: center;
    justify-content: space-between;

    > .add {
      width: 44px;
      height: 44px;
      border-radius: 22px;
      border: none;
      background: ${colors.buttonBackgroundHover()};
      display: flex;
      align-items: center;
      justify-content: center;

      > svg {
        width: 20px;
        height: 20px;
      }
    }
  }

  > .cards {
    display: flex;
    flex-flow: column;
    gap: 14px;
  }

  /* Adding one. */

  > .cancel {
    align-self: flex-start;
    margin: -12px 0 0 -8px;
    padding: 0 8px;
    height: 44px;
    border: none;
    background: transparent;
    color: ${colors.primary()};
    font: ${fonts.displayMedium({ size: 16 })};
  }

  > .picture {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    height: 96px;
    flex-shrink: 0;
    color: ${colors.textSecondary()};

    > .phone {
      width: 48px;
      height: 48px;
      stroke-width: 1.4;
    }

    > .laptop {
      width: 80px;
      height: 80px;
      stroke-width: 1.1;
    }

    > .line {
      position: relative;
      width: 100px;
      height: 2px;
      background-image: linear-gradient(90deg, ${colors.separator()} 50%, transparent 50%);
      background-size: 8px 2px;

      > .dot {
        position: absolute;
        top: -3px;
        width: 8px;
        height: 8px;
        border-radius: 4px;
        background: ${colors.primary()};
        animation: ${travel} 1.6s ease-in-out infinite;
      }
    }
  }

  > .intro {
    display: flex;
    flex-flow: column;
    gap: 8px;
    text-align: center;

    > h1 {
      font: ${fonts.displayBold({ size: 26, line: "32px" })};
    }

    > p {
      margin: 0;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 16, line: "22px" })};
    }
  }

  > .steps {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-flow: column;
    gap: 14px;

    > li {
      display: flex;
      align-items: flex-start;
      gap: 12px;
      font: ${fonts.display({ size: 15, line: "21px" })};

      > .number {
        flex-shrink: 0;
        width: 26px;
        height: 26px;
        margin-top: -2px;
        border-radius: 13px;
        background: ${colors.buttonBackgroundHover()};
        display: flex;
        align-items: center;
        justify-content: center;
        font: ${fonts.displayBold({ size: 13 })};
      }

      b {
        font: ${fonts.displayBold({ size: 15, line: "21px" })};
      }
    }
  }

  > .space {
    flex-grow: 1;
  }

  > form {
    display: flex;
    flex-flow: column;
    gap: 12px;

    > label {
      margin-left: 4px;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 13 })};
    }

    > .problem {
      margin: 0;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 13, line: "18px" })};
    }
  }
`;

const StyledMacCard = styled.div`
  position: relative;
  display: flex;
  flex-flow: column;
  gap: 14px;
  padding: 18px;
  border: none;
  border-radius: 18px;
  background: ${colors.buttonBackgroundGlow()};
  box-shadow: inset 0 0 0 1px ${colors.separator()};
  user-select: none;

  &:has(> .top > .pick:active) {
    background: ${colors.buttonBackgroundHover()};
  }

  > .top {
    display: flex;
    align-items: center;
    gap: 14px;

    > .icon {
      flex-shrink: 0;
      width: 48px;
      height: 48px;
      border-radius: 14px;
      background: ${colors.buttonBackgroundHover()};
      color: ${colors.textSecondary()};
      display: flex;
      align-items: center;
      justify-content: center;

      > svg {
        width: 26px;
        height: 26px;
        stroke-width: 1.8;
      }
    }

    > .pick {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      flex-flow: column;
      gap: 2px;
      padding: 0;
      border: none;
      background: transparent;
      text-align: left;

      &::after {
        content: "";
        position: absolute;
        inset: 0;
        border-radius: 18px;
      }

      > .name {
        font: ${fonts.displayBold({ size: 20, line: "26px" })};
        overflow-wrap: anywhere;
      }

      > .detail {
        display: flex;
        align-items: center;
        gap: 6px;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 14, line: "20px" })};
      }
    }

    > .more {
      position: relative;
      z-index: 1;
      flex-shrink: 0;
      width: 44px;
      height: 44px;
      margin: -8px -10px -8px 0;
      border: none;
      border-radius: 22px;
      background: transparent;
      color: ${colors.textSecondary()};
      display: flex;
      align-items: center;
      justify-content: center;

      &:active {
        background: ${colors.buttonBackgroundHover()};
      }

      > svg {
        width: 20px;
        height: 20px;
      }
    }
  }

  &[data-live="true"] > .top > .icon {
    background: ${colors.primary()};
    color: #fff;
  }

  > .workspaces {
    display: flex;
    flex-flow: column;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid ${colors.separator()};

    > .workspace {
      display: flex;
      align-items: center;
      gap: 10px;
      font: ${fonts.display({ size: 15, line: "20px" })};

      > .title {
        flex-grow: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      > .status {
        flex-shrink: 0;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 14 })};

        &[data-status="waiting"] {
          color: ${statusColors.waiting};
        }
      }
    }
  }
`;
