import { colors } from "crosswing/colors";
import { BottomScrollable } from "crosswing/components/BottomScrollable";
import { PanelLayout, PanelLayoutContext, StyledPanelLayout } from "crosswing/components/PanelLayout";
import { StyledTextArea, TextArea } from "crosswing/components/forms/TextArea";
import { fonts } from "crosswing/fonts";
import { ModalContext } from "crosswing/modals/context";
import { HotkeyView, StyledHotkeyView } from "crosswing/modals/popup/HotkeyView";
import { tooltip } from "crosswing/modals/popup";
import { useDraggable } from "crosswing/components/draggable/useDraggable";
import { ArrowUp, ChevronRight, LoaderCircle, Mic, Paperclip, Square, TextQuote, X } from "lucide-react";
import type { ChatEntry, OpenFile, Tab } from "miks/shared/protocol";
import { DEFAULT_SETTINGS } from "miks/shared/settings";
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type CSSProperties,
  Fragment,
  type ReactNode,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { styled } from "styled-components";
import { coarsePointer } from "crosswing/host/pointer";
import { padSafeArea } from "crosswing/safearea";
import { BrowseView } from "./BrowseView";
import { useCodeMenu } from "./codeMenu";
import { daemon } from "./daemon";
import { useDictation } from "./dictation";
import { StyledWaveform, Waveform } from "./Waveform";
import { closeFile, FileView } from "./FileView";
import { accentColor, addCopyButtons, copyCode, markdownCSS, renderMarkdown } from "./markdown";
import { type Notice, Pill } from "./Pill";
import { autoFocus, useSettings } from "./settings";
import { openLink } from "./links";
import {
  attachedText,
  droppedText,
  focusActiveTerminal,
  isPasteImageKey,
  onDragOver,
  pasteClipboardImage,
  sendEscape,
  sendToTerminal,
} from "./TerminalView";

/** ⌃D: hides the panel (in the composer, instead of deleting forward). */
const isHideKey = (event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
  event.key === "d" && event.ctrlKey && !event.metaKey && !event.altKey;

/**
 * What the panel keeps about a tab goes by its key, which a daemon restart
 * gives back to the restored tab; its id is a new pane's. A daemon from
 * before protocol 6 sends no key.
 */
const keyOf = (tab: Pick<Tab, "id" | "key">) => tab.key ?? tab.id;

/**
 * What you've started writing in each tab, kept while you look at others and
 * across relaunches and daemon restarts, and the same in every window (a
 * Mac's, the iOS app's): the daemon keeps it with the tab and hands it on.
 * Also in this window's storage, for an older daemon, which doesn't.
 */
const drafts = {
  get(tab: Tab): string {
    const shared = daemon.draft(tab.id);
    if (shared !== undefined) return shared;
    try {
      return localStorage.getItem(`ChatPanel:draft:${keyOf(tab)}`) ?? "";
    } catch {
      return "";
    }
  },
  set(tab: Tab, text: string) {
    drafts.keep(tab, text);
    daemon.setDraft(tab.id, text);
  },
  /** Only here: for one another window wrote. */
  keep(tab: Tab, text: string) {
    try {
      if (text) localStorage.setItem(`ChatPanel:draft:${keyOf(tab)}`, text);
      else localStorage.removeItem(`ChatPanel:draft:${keyOf(tab)}`);
    } catch {}
  },
};

/** Whether a prompt in the transcript is one sent from here, however its whitespace came out. */
/**
 * Whether a prompt in the transcript is one sent from here, however its
 * whitespace came out. Contains, not equals: what was already in Claude's
 * prompt goes in front of it, like an image pasted with ⌃V ("[Image #1]").
 */
const sentAs = (prompt: string, sent: string) => {
  const squash = (text: string) => text.replace(/\s+/g, " ").trim();
  return squash(prompt).includes(squash(sent));
};

/**
 * Something set for some tabs, by key: kept in this window's storage, so a
 * relaunch leaves them as they were.
 */
function tabFlags(storageKey: string) {
  const keys = new Set<string>(read());
  const listeners = new Set<() => void>();

  function read(): string[] {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    } catch {
      return [];
    }
  }

  return {
    has: (tab: Tab) => keys.has(keyOf(tab)),
    set(tab: Tab, on: boolean) {
      const key = keyOf(tab);
      if (on === keys.has(key)) return;
      if (on) keys.add(key);
      else keys.delete(key);
      try {
        localStorage.setItem(storageKey, JSON.stringify([...keys]));
      } catch {}
      for (const listener of listeners) listener();
    },
    useFlag(tab: Tab | null): boolean {
      const key = tab ? keyOf(tab) : null;
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => !!key && keys.has(key),
      );
    },
  };
}

/**
 * Which tabs have their panel open: each tab's own, like its terminal, and
 * only ever shown with something in it (Claude Code's conversation, a file,
 * a page).
 */
const openTabs = tabFlags("ChatPanel:open");

/**
 * Which tabs' panels fill the tab, over the terminal, rather than sitting
 * beside it (⌘⇧F). One that does fades in and out instead of sliding.
 */
const expandedTabs = tabFlags("ChatPanel:expanded");

/**
 * Which tabs' conversations were closed (the ✕ on Chat), leaving their
 * files and page in the panel. Opening the panel yourself (⌘⇧C) or a new
 * session brings it back.
 */
const chatClosedTabs = tabFlags("ChatPanel:chatClosed");

/**
 * The order you've dragged each tab's panel tabs into, in this window's
 * storage like the rest; what isn't in it goes after, as it came.
 */
const viewOrders = {
  get(tab: Tab): string[] {
    try {
      return JSON.parse(localStorage.getItem(`ChatPanel:order:${keyOf(tab)}`) ?? "[]");
    } catch {
      return [];
    }
  },
  set(tab: Tab, order: string[]) {
    try {
      localStorage.setItem(`ChatPanel:order:${keyOf(tab)}`, JSON.stringify(order));
    } catch {}
  },
};

/** What the menu's tab commands do in each tab's panel, while the keyboard's in it. */
const panelCommands = new Map<string, { step: (offset: number) => boolean; close: () => boolean }>();

/**
 * ⌘⇧[ and ⌘⇧]: with the keyboard in the tab's panel, the panel's tab
 * before or after; false past its ends, for the tab bar's to take over.
 */
export const stepPanel = (tab: Tab, offset: number) => panelCommands.get(tab.id)?.step(offset) ?? false;

/**
 * ⌘W: with the keyboard in the tab's panel, closes what it shows (asking
 * first if it's a file with changes), never the terminal's tab.
 */
export const closeInPanel = (tab: Tab) => panelCommands.get(tab.id)?.close() ?? false;

export const isChatOpen = openTabs.has;
/** Opens or closes a tab's panel for you (a long reply, a file arriving), not as your choice. */
export const setChatOpen = openTabs.set;
export const useChatOpen = openTabs.useFlag;
export const useExpanded = expandedTabs.useFlag;

/** Whether a tab has anything for its panel to show. */
export const hasPanel = (tab: Tab | null | undefined) => !!(tab?.agent || tab?.file || tab?.page);

/** The files in a tab's panel; an older daemon has one at most. */
const openFiles = (tab: Tab): OpenFile[] => tab.files ?? (tab.file ? [tab.file] : []);

/** Set when you open the panel yourself: the composer takes the keyboard. */
let focusOnShow = false;

/** Opens or closes a tab's panel (⌘⇧C, or the tab bar's button), moving the keyboard with it. */
export function toggleChat(tab: Tab) {
  const open = !isChatOpen(tab);
  if (open) {
    focusOnShow = true;
    chatClosedTabs.set(tab, false);
  }
  else focusActiveTerminal();
  choosePanel(tab, open);
}

/**
 * Whether a Claude session you start opens its tab's panel: until you close
 * one it opened right away, and again once you open one yourself.
 */
const AUTO_OPEN_KEY = "ChatPanel:autoOpen";
const AUTO_OPEN_CHANGED_MIND = 20_000;
let autoOpened: { key: string; time: number } | null = null;

function autoOpens(): boolean {
  try {
    return localStorage.getItem(AUTO_OPEN_KEY) !== "false";
  } catch {
    return true;
  }
}

/** Opens or closes a tab's panel as you chose, which says whether you want it when sessions start. */
function choosePanel(tab: Tab, open: boolean) {
  const closedRightAway = !open && autoOpened?.key === keyOf(tab) && Date.now() - autoOpened.time < AUTO_OPEN_CHANGED_MIND;
  if (closedRightAway || (open && tab.agent)) {
    try {
      localStorage.setItem(AUTO_OPEN_KEY, String(open));
    } catch {}
  }
  autoOpened = null;
  setChatOpen(tab, open);
}

/** Each tab's area (`ChatLayout`), for putting the keyboard in its panel. */
const layoutRoots = new Map<string, HTMLElement>();

/** ⌥⌘→: the keyboard into the tab's panel, to what it shows, opening it if it's hidden. */
export function focusPanelOf(tab: Tab) {
  if (!hasPanel(tab)) return;
  if (!isChatOpen(tab)) return toggleChat(tab);
  const root = layoutRoots.get(tab.id);
  if (root) focusPanel(root, "composer");
}

/** ⌥⌘←: the keyboard back to the terminal, which a panel filling the tab (⌘⇧F) makes room for. */
export function focusTerminalOf(tab: Tab) {
  if (!expandedTabs.has(tab)) return focusActiveTerminal();
  expandedTabs.set(tab, false);
  // Once it's rendered: until then the terminal's under it, inert.
  setTimeout(focusActiveTerminal);
}

/** Makes a tab's panel fill the tab, or go back beside the terminal (⌘⇧F); a hidden one comes back filling it. */
export function toggleExpanded(tab: Tab) {
  if (!isChatOpen(tab)) {
    expandedTabs.set(tab, true);
    toggleChat(tab);
  } else {
    expandedTabs.set(tab, !expandedTabs.has(tab));
  }
}

/**
 * A tab's area: its terminal, and beside it (or, where that would leave the
 * terminal under 600px, over it) its chat panel, while Claude Code runs in it.
 */
export function ChatLayout({
  tab,
  active,
  supported,
  children,
}: {
  tab: Tab;
  active: boolean;
  supported: boolean;
  children: ReactNode;
}) {
  // Open or not is the panel's, apart from what's in it: hiding it (⌘⇧C,
  // Escape) leaves an open file as it was, unsaved changes and all.
  const panelOpen = useChatOpen(tab);
  const expanded = useExpanded(tab);
  const chatClosed = chatClosedTabs.useFlag(tab);
  const { page } = tab;
  const files = openFiles(tab);
  // Which of what it has the panel shows: what you picked, or else the
  // latest to open (a page, then a file, then the conversation).
  const [view, setView] = useState<PanelView>("page");
  const [order, setOrder] = useState(() => viewOrders.get(tab));
  const views = ordered(panelViews(tab, chatClosed), order);
  const visible = panelOpen && views.length > 0;
  // Picked (a click, ⌘⇧[ and ⌘⇧]), it takes the keyboard once it's on show.
  const focusShown = useRef(false);
  const showing: PanelView = views.includes(view) ? view : (views.at(-1) ?? "chat");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current) layoutRoots.set(tab.id, ref.current);
    return () => {
      layoutRoots.delete(tab.id);
    };
  }, [tab.id]);

  // A file or page opening (or opened again) comes to the front, opening
  // the panel if it was closed; and a panel opened for them closes once
  // they're gone.
  const opened = useRef({ files: new Map(files.map((file) => [file.id, file.opened ?? 0])), page: page?.id });
  const openedForContent = useRef(false);
  useEffect(() => {
    const before = opened.current;
    opened.current = { files: new Map(files.map((file) => [file.id, file.opened ?? 0])), page: page?.id };
    const file = files.find((file) => (before.files.get(file.id) ?? -1) < (file.opened ?? 0));
    const arrived: PanelView | null = page && page.id !== before.page ? "page" : file ? `file:${file.id}` : null;
    if (arrived) {
      setView(arrived);
      if (arrived === "page" && page?.fill) expandedTabs.set(tab, true);
      if (!isChatOpen(tab)) {
        openedForContent.current = true;
        setChatOpen(tab, true);
      }
    } else if (files.length === 0 && !page && (openedForContent.current || chatClosed) && (before.files.size > 0 || before.page)) {
      // With its conversation closed too, there's nothing left: it comes
      // back the next time the panel opens.
      openedForContent.current = false;
      chatClosedTabs.set(tab, false);
      setChatOpen(tab, false);
    }
  }, [files.map((file) => `${file.id}.${file.opened ?? 0}`).join(), page?.id]);

  // A Claude session you start here opens the panel (one a restore brought
  // back was left as it was), its composer taking the keyboard if it's on
  // screen, unless that would bring up an on-screen one (autoFocus()).
  const hadAgent = useRef(!!tab.agent);
  useEffect(() => {
    const had = hadAgent.current;
    hadAgent.current = !!tab.agent;
    if (!had && tab.agent) chatClosedTabs.set(tab, false);
    if (had || !tab.agent || tab.agent.restored || isChatOpen(tab) || !autoOpens()) return;
    autoOpened = { key: keyOf(tab), time: Date.now() };
    if (active) focusOnShow = true;
    setChatOpen(tab, true);
  }, [!!tab.agent]);

  // Coming back to the tab, the keyboard goes back where it was: into the
  // panel, if it was there. And always into the panel when it covers the
  // terminal. Where it was is read first (layout effects run before the
  // rest), because the terminal takes the keyboard as it comes on screen,
  // which would record that instead; this puts it back after.
  const returnTo = useRef<PanelPlace | undefined>(undefined);
  useLayoutEffect(() => {
    returnTo.current = active ? panelFocus.get(tab.id) : undefined;
  }, [active]);

  useEffect(() => {
    if (!focusShown.current || !ref.current) return;
    focusShown.current = false;
    focusPanel(ref.current, showing === "chat" ? "composer" : showing === "page" ? "page" : "file");
  }, [showing]);

  // Opened yourself (⌘⇧C) with a file or page showing: the keyboard goes to it.
  useEffect(() => {
    if (!visible || !focusOnShow || showing === "chat" || !ref.current) return;
    focusOnShow = false;
    focusPanel(ref.current, showing === "page" ? "page" : "file");
  }, [visible]);

  useEffect(() => {
    const root = ref.current;
    if (!active || !visible || !root) return;
    const overlay = expanded || root.querySelector(":scope > [data-mode]")?.getAttribute("data-mode") === "overlay";
    const where = returnTo.current;
    if (where || overlay) focusPanel(root, where ?? "composer");
  }, [active]);

  return (
    <StyledChatLayout
      data-active={active}
      data-expanded={expanded}
      ref={ref}
      onFocus={(event) => {
        const target = event.target as HTMLElement;
        const where = target.closest(".file-view")
          ? "file"
          : target.closest(".page-view")
            ? "page"
            : target.closest(".composer")
            ? "composer"
            : target.closest(".scroller")
              ? "conversation"
              : null;
        if (where) panelFocus.set(tab.id, where);
        else panelFocus.delete(tab.id);
      }}
    >
      <PanelLayout
        edge="right"
        mode="auto"
        panelVisible={visible}
        // A click on the shaded terminal (overlay mode) hides it.
        onPanelVisibleChange={(open) => {
          choosePanel(tab, open);
          if (!open) focusActiveTerminal();
        }}
        panelDefaultSize={420}
        panelMinSize={300}
        panelMaxSize={900}
        contentMinSize={600}
        hotkey={null}
        hideToolbarButton
        hideDragHandle
        restorationKey={ChatPanel}
      >
        <TerminalArea active={active} expanded={expanded}>
          {children}
        </TerminalArea>
        <ChatPanel
          tab={tab}
          views={views}
          onReorder={(next) => {
            setOrder(next);
            viewOrders.set(tab, next);
          }}
          visible={visible}
          supported={supported}
          showing={showing}
          onShow={(next) => {
            focusShown.current = true;
            setView(next);
          }}
          onHide={() => {
            choosePanel(tab, false);
            focusActiveTerminal();
          }}
          focusFile={active}
        />
      </PanelLayout>
    </StyledChatLayout>
  );
}

/** What a tab's panel can show: its conversation, one of its files, or its page. */
type PanelView = "chat" | `file:${string}` | "page";

/** What a tab's panel has to show, in the order they're offered. */
const panelViews = (tab: Tab, chatClosed: boolean): PanelView[] => [
  ...(tab.agent && !chatClosed ? (["chat"] as const) : []),
  ...openFiles(tab).map((file) => `file:${file.id}` as const),
  ...(tab.page ? (["page"] as const) : []),
];

/** Views in the order you've put them in, the rest after as they were. */
function ordered(views: PanelView[], order: string[]): PanelView[] {
  const rank = (view: PanelView) => {
    const index = order.indexOf(view);
    return index === -1 ? order.length + views.indexOf(view) : index;
  };
  return [...views].sort((a, b) => rank(a) - rank(b));
}

/** Where in a tab's panel the keyboard can be. */
type PanelPlace = "composer" | "conversation" | "file" | "page";

/** Where in its panel each tab had the keyboard last, if it was there. */
const panelFocus = new Map<string, PanelPlace>();

/**
 * Puts the keyboard there, if that's on show, or else whatever the panel is
 * showing: the file's editor, or the composer (unless it's disabled, with
 * no session yet: then the conversation).
 */
function focusPanel(root: HTMLElement, where: PanelPlace) {
  // The one on show, of those there are (each file has its own, hidden or not).
  const shown = <T extends HTMLElement>(selector: string) =>
    [...root.querySelectorAll<T>(selector)].find((element) => element.offsetParent) ?? null;
  const editor = shown(".file-view .cm-content") ?? shown(".file-view .markdown-view");
  const page = shown(".page-view webview");
  const composer = shown<HTMLTextAreaElement>(".composer textarea");
  const conversation = shown(".scroller");
  const usable = composer && !composer.disabled ? composer : null;
  const target =
    where === "page"
      ? (page ?? editor ?? usable ?? conversation)
      : where === "file"
        ? (editor ?? page ?? usable ?? conversation)
        : where === "conversation"
          ? (conversation ?? editor ?? page)
          : (usable ?? editor ?? page ?? conversation);
  if (autoFocus()) target?.focus({ preventScroll: true });
}

/**
 * The terminal's side. While the panel covers it (overlay mode), it can't
 * have the keyboard, or you'd type behind the shade: the keyboard goes into
 * the panel instead, and back once the panel's gone.
 */
function TerminalArea({ active, expanded, children }: { active: boolean; expanded: boolean; children: ReactNode }) {
  const { panelVisible, panelMode } = use(PanelLayoutContext);
  const covered = panelVisible && (panelMode === "overlay" || expanded);
  const ref = useRef<HTMLDivElement>(null);
  const wasCovered = useRef(covered);

  useEffect(() => {
    const before = wasCovered.current;
    wasCovered.current = covered;
    if (!active || covered === before) return;

    const root = ref.current?.closest<HTMLElement>("[data-active]");
    if (covered && root) focusPanel(root, "composer");
    // Only if the keyboard's nowhere, or in the panel that just closed
    // (inert now, though the browser takes a while to notice), not when a
    // wider window lets the panel move aside.
    else if (!covered) {
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused.closest("[inert]")) focusActiveTerminal();
    }
  }, [covered]);

  return (
    <div className="terminal-area" ref={ref} inert={covered}>
      {children}
    </div>
  );
}

const StyledChatLayout = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  visibility: hidden;

  &[data-active="true"] {
    visibility: visible;
  }

  > * {
    flex-grow: 1;
    min-width: 0;
  }

  .terminal-area {
    position: relative;
  }

  /* Filling the tab (⌘⇧F): over the terminal, which keeps its size, and
     fading in and out rather than sliding the whole width. */
  &[data-expanded="true"] > ${StyledPanelLayout} {
    > .content[data-panel-edge] {
      margin: 0;
    }

    > .overlay[data-panel-edge] {
      display: none;
    }

    > .panel[data-panel-edge] {
      width: 100%;
      border-left: none;
      box-shadow: none;
      transform: none;
      transition:
        opacity 0.15s ease-in-out,
        width 0.2s ease-in-out;

      > .dragger {
        display: none;
      }
    }

    &[data-panel-visible="false"] > .panel[data-panel-edge] {
      opacity: 0;
    }
  }
`;

// Styled on its own, not from inside the row: the copy that follows the
// pointer while dragging is put outside it, and must still look the part.
// Its spacing is padding inside its border box, with the visuals on .box, so
// that copy (sized from the border box) matches and nothing shifts.
const StyledViewTab = styled.div`
  flex-shrink: 0;
  display: flex;
  box-sizing: border-box;
  max-width: 60%;
  padding: 0 1px;
  cursor: default;
  user-select: none;

  > .box {
    flex-grow: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    box-sizing: border-box;
    height: 28px;
    padding: 0 4px 0 10px;
    border-radius: 7px;
    color: ${colors.textSecondary()};

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
    }

    > .unsaved {
      flex-shrink: 0;
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }

    > .label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: ${fonts.displayMedium({ size: 12, line: "16px" })};
    }

    > .close {
      flex-shrink: 0;
      display: flex;
      padding: 2px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      opacity: 0;
      /* Hidden, it isn't there: tapping where it would be picks the tab. */
      pointer-events: none;

      > svg {
        width: 12px;
        height: 12px;
      }

      &:hover {
        background: ${colors.buttonBackgroundGlow()};
      }
    }

    @media (hover: hover) {
      &:hover > .close {
        opacity: 0.7;
        pointer-events: auto;
      }
    }
  }

  &[data-on="true"] > .box {
    background: ${colors.linkActiveBackground()};
    color: ${colors.text()};

    > .close {
      opacity: 0.7;
      pointer-events: auto;
    }
  }

  &[data-dragging="true"] > .box {
    background: ${colors.textBackgroundPanel()};
    color: ${colors.text()};
    box-shadow: 0 4px 14px rgb(0 0 0 / 0.25);
  }

  ${coarsePointer(`
    > .box {
      height: 36px;
      padding: 0 4px 0 12px;
      border-radius: 10px;

      > .label {
        font-size: 14px;
      }

      > .close {
        padding: 6px;
        border-radius: 8px;

        > svg {
          width: 15px;
          height: 15px;
        }
      }
    }
  `)}
`;

const ViewDropTarget = styled.div`
  flex-shrink: 0;
  align-self: center;
  width: var(--target-width, 0px);
  height: 28px;
  border-radius: 7px;

  &[data-draggable-hover="true"] {
    background: ${colors.buttonBackgroundGlow()};
  }
`;

/**
 * The tab's Claude Code conversation, for reading in proportional type with
 * real markdown, and a place to write the next message. Everything here is
 * read from the session's transcript (the daemon follows it), and a message
 * sent from here is typed into the terminal, so the terminal stays the
 * truth: this is another view of it.
 */
export function ChatPanel({
  tab,
  views,
  onReorder,
  visible,
  supported,
  showing,
  onShow,
  onHide,
  focusFile,
}: {
  tab: Tab;
  /** What it has to show (panelViews), in your order. */
  views: PanelView[];
  onReorder: (views: PanelView[]) => void;
  visible: boolean;
  supported: boolean;
  /** The conversation, the tab's file or its page; each stays put while another shows. */
  showing: PanelView;
  onShow: (showing: PanelView) => void;
  /** Hides the panel (Escape in the file), leaving what's in it as it is. */
  onHide: () => void;
  /** Whether the file's editor takes the keyboard as it opens (`miks edit`). */
  focusFile: boolean;
}) {
  const { fontSize } = useSettings();
  const [pageTitle, setPageTitle] = useState("");
  // Files with changes not yet saved, marked in their tabs.
  const [unsaved, setUnsaved] = useState<Record<string, boolean>>({});
  // With more than one thing in it, each has a tab, and the one showing has
  // its controls beside them, here, rather than a header of its own.
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const tabbed = views.length > 1;
  const files = openFiles(tab);
  const fileOf = (view: PanelView) => files.find((file) => view === `file:${file.id}`);
  const label = (view: PanelView) =>
    view === "chat" ? "Chat" : view === "page" ? pageTitle || hostOf(tab.page?.url) : fileOf(view)?.path.split("/").pop();
  const hint = (view: PanelView) => (view === "page" ? (tab.page?.url ?? null) : (fileOf(view)?.path ?? null));

  // Press and hold a tab to drag it along the row, as in the tab bar. Each
  // panel's its own group: they're all on the page, hidden or not.
  const group = `panel-views:${tab.id}`;
  useDraggable({
    group,
    lockAxis: "x",
    onDrop: (moving, target) => {
      const rest = views.filter((view) => view !== moving);
      const index = target.startsWith("after:") ? rest.indexOf(target.slice("after:".length) as PanelView) + 1 : 0;
      rest.splice(index, 0, moving as PanelView);
      onReorder(rest);
    },
  });

  /**
   * Closes one of its tabs, showing the one beside it if it was on show; the
   * last one closing hides the panel. The conversation only goes from the
   * panel: it comes back with ⌘⇧C.
   */
  async function close(view: PanelView) {
    const file = fileOf(view);
    if (file && !(await closeFile(tab, file, !!unsaved[file.id]))) return;
    if (view === "chat" && views.length > 1) chatClosedTabs.set(tab, true);
    if (view === "page") daemon.send({ type: "closePage", tabId: tab.id });

    const index = views.indexOf(view);
    const next = views[index + 1] ?? views[index - 1];
    if (!next) onHide();
    else if (view === showing) onShow(next);
  }

  const rootRef = useRef<HTMLDivElement>(null);
  const hasKeyboard = () => visible && !!rootRef.current?.contains(document.activeElement);
  useEffect(() => {
    panelCommands.set(tab.id, {
      step(offset) {
        const next = views[views.indexOf(showing) + offset];
        if (!hasKeyboard() || !next) return false;
        onShow(next);
        return true;
      },
      close() {
        if (!hasKeyboard()) return false;
        void close(showing);
        return true;
      },
    });
    return () => {
      panelCommands.delete(tab.id);
    };
  });

  return (
    // Its text grows and shrinks with the terminal's (⌘= and ⌘-), through
    // the font scale crosswing's fonts all follow.
    <StyledChatPanel
      ref={rootRef}
      data-showing={showing.startsWith("file:") ? "file" : showing}
      style={{ "--font-scale": fontSize / DEFAULT_SETTINGS.fontSize } as CSSProperties}
    >
      {tabbed && (
        <div className="switcher">
          <div className="views" data-draggable-root>
            <ViewDropTarget data-draggable-target="top" data-draggable-group={group} />
            {views.map((view) => (
              <Fragment key={view}>
                <StyledViewTab
                  data-draggable-id={view}
                  data-draggable-group={group}
                  data-on={showing === view}
                  onClick={() => onShow(view)}
                  onAuxClick={(event) => event.button === 1 && close(view)}
                  {...tooltip(hint(view), { delay: true, placement: "below" })}
                >
                  <div className="box">
                    {fileOf(view) && unsaved[fileOf(view)!.id] && <span className="unsaved" />}
                    <span className="label">{label(view)}</span>
                    <button
                      className="close"
                      // Not a drag: closing should work on a quick click.
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        close(view);
                      }}
                      {...tooltip("Close", { delay: true })}
                    >
                      <X />
                    </button>
                  </div>
                </StyledViewTab>
                <ViewDropTarget
                  data-draggable-target={`after:${view}`}
                  data-draggable-group={group}
                  data-draggable-related-id={view}
                />
              </Fragment>
            ))}
          </div>
          <div className="tools" ref={setToolbar} />
        </div>
      )}
      {tab.agent && supported && <Conversation tab={tab} visible={visible} showing={showing === "chat"} />}
      {tab.agent && !supported && (
        <div className="note">This tab's Mac has an older Miks. Update it there to see conversations here.</div>
      )}
      {files.map((file) => (
        <div key={file.id} className="file-view" hidden={showing !== `file:${file.id}`}>
          <FileView
            tab={tab}
            file={file}
            toolbar={tabbed ? (showing === `file:${file.id}` ? toolbar : null) : undefined}
            focusOnOpen={focusFile && file.edit}
            onHide={onHide}
            onUnsaved={(value) => setUnsaved((current) => ({ ...current, [file.id]: value }))}
          />
        </div>
      ))}
      {tab.page && (
        <div className="page-view">
          <BrowseView tab={tab} page={tab.page} closable={!tabbed} onTitle={setPageTitle} />
        </div>
      )}
    </StyledChatPanel>
  );
}

const hostOf = (url = "") => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

type Item =
  | { kind: "prompt"; entry: ChatEntry & { text: string } }
  | { kind: "reply"; entry: ChatEntry & { text: string }; final?: boolean }
  | { kind: "tools"; entries: Extract<ChatEntry, { kind: "tool" }>[] };

/**
 * Tool calls in a row become one line. And the start of each turn's final
 * reply (what comes after its last tool call) is marked: that's the one to
 * read, after whatever Claude said to itself on the way. Not in a turn
 * still going (`working`), where the latest words may not be the last.
 */
function group(entries: ChatEntry[], working: boolean): Item[] {
  const items: Item[] = [];
  for (const entry of entries) {
    const last = items.at(-1);
    if (entry.kind === "tool") {
      if (last?.kind === "tools") last.entries.push(entry);
      else items.push({ kind: "tools", entries: [entry] });
    } else {
      items.push({ kind: entry.kind, entry });
    }
  }

  let turnStart = 0;
  const markTurn = (end: number) => {
    // The replies at the end of the turn, back to its last tool call.
    let first = end;
    while (first > turnStart && items[first - 1].kind === "reply") first--;
    const answer = items[first];
    // Only worth marking with something before it to tell it from.
    if (first < end && first > turnStart && answer.kind === "reply") answer.final = true;
  };
  for (let i = 0; i <= items.length; i++) {
    if (i < items.length && items[i].kind !== "prompt") continue;
    if (i < items.length || !working) markTurn(i);
    turnStart = i + 1;
  }
  return items;
}

/** The most kept in the panel at once, as in the daemon. */
const MAX_ENTRIES = 2000;

function Conversation({ tab, visible, showing }: { tab: Tab; visible: boolean; showing: boolean }) {
  const [chat, setChat] = useState<{ session: string | null; entries: ChatEntry[] } | null>(null);
  const [text, setText] = useState(drafts.get(tab));
  // Sent from here and not yet in the transcript: shown right away, faded.
  const [pending, setPending] = useState<{ id: string; text: string; time: number }[]>([]);
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  // What ⌃V did, above the composer.
  const [notice, setNotice] = useState<Notice | null>(null);
  // The conversation, in its BottomScrollable (its parent), which keeps it at
  // the bottom by itself (column-reverse), as you send or it grows: scrollTop
  // is 0 there, and negative above.
  const conversationRef = useRef<HTMLDivElement>(null);
  const codeMenu = useCodeMenu(tab.id);
  const scroller = () => conversationRef.current?.parentElement ?? null;
  const composerRef = useRef<HTMLFormElement>(null);
  const atBottom = useRef(true);
  // Whether following stopped at a reply's start, to keep it on screen (see
  // below), until you scroll; and where it last scrolled to itself, which
  // isn't you scrolling.
  const pinned = useRef(false);
  const scrolledTo = useRef(0);
  // Where you'd scrolled to, for when it shows again after a file: hidden
  // (display: none), it forgets, and comes back at its top, not the bottom.
  const scrollTop = useRef(0);
  // The conversation came all at once (opening it, or a rewind), not as it went.
  const loaded = useRef(false);
  const { showToast } = use(ModalContext);
  const status = tab.agent?.status;

  // Only while it's showing; a hidden panel needn't follow anything.
  useEffect(() => {
    if (!visible) return;
    return daemon.watchChat(tab.id, (event) => {
      if (event.reset) loaded.current = true;
      setChat((current) => ({
        session: event.session,
        entries: event.reset ? event.entries : [...(current?.entries ?? []), ...event.entries].slice(-MAX_ENTRIES),
      }));
      // Once Claude Code has it, it's the transcript's to show. (Only since
      // it was sent: you may well have said "yes" before.)
      const prompts = event.entries.filter((entry) => entry.kind === "prompt");
      if (prompts.length === 0) return;
      setPending((current) =>
        current.filter(
          (sent) => !prompts.some((prompt) => prompt.time >= sent.time - 5000 && sentAs(prompt.text, sent.text)),
        ),
      );
    });
  }, [tab.id, visible]);

  // Once there's a session: until then the field is disabled, and won't take it.
  useEffect(() => {
    // Not with the file showing instead (ChatLayout gives it the editor).
    if (!visible || !chat?.session || !focusOnShow || !composerRef.current?.offsetParent) return;
    focusOnShow = false;
    if (autoFocus()) focusComposer();
  }, [visible, chat?.session]);

  // New messages keep it at the bottom (the BottomScrollable does), unless
  // you've scrolled up to read. But not past the start of the words it ends
  // with: you watch tool calls go by, then read the reply from its top.
  // Whether words are the turn's last isn't known until it ends, so any are;
  // a tool call after them carries on to the bottom. Not for one loaded all
  // at once (opening Miks again), which was read as it went, if at all, and
  // goes to the bottom.
  useLayoutEffect(() => {
    const element = scroller();
    const wasLoaded = loaded.current;
    loaded.current = false;
    if (!element || !conversationRef.current || !(atBottom.current || pinned.current)) return;
    const start = wasLoaded ? null : replyStart(conversationRef.current);
    // Where the start is at the top, if the bottom would leave it above.
    const target = start ? Math.min(0, scrollTopFor(element, start, 12)) : 0;
    pinned.current = target < -1;
    scrolledTo.current = target;
    element.scrollTop = target;
  }, [chat, pending, status]);

  // Back from a file or page, where it was.
  useLayoutEffect(() => {
    const element = scroller();
    if (showing && element) element.scrollTop = atBottom.current ? 0 : scrollTop.current;
  }, [showing]);

  // ⌃D hides the panel for the terminal, where two more quit Claude Code.
  function hide() {
    choosePanel(tab, false);
    focusActiveTerminal();
  }

  // Escape goes back to the terminal; over it, there's no getting to it but
  // by closing the panel.
  const { panelMode } = use(PanelLayoutContext);
  function leave() {
    if (panelMode === "overlay" || expandedTabs.has(tab)) choosePanel(tab, false);
    else focusActiveTerminal();
  }

  // Without scrolling: the panel may still be sliding in, and the browser
  // would scroll the whole tab sideways to bring the field into view.
  function focusComposer() {
    const textarea = composerRef.current?.querySelector("textarea");
    textarea?.focus({ preventScroll: true });
    textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function changeText(next: string) {
    setText(next);
    drafts.set(tab, next);
  }

  // What's there now, not as of this render: words and files arrive later.
  function insert(addition: string) {
    const text = drafts.get(tab);
    const joined = text && !text.endsWith("\n") && !text.endsWith(" ") ? `${text} ${addition}` : text + addition;
    changeText(joined);
    focusComposer();
  }

  const session = chat?.session ?? null;
  // A permission prompt or a question takes keys, not messages.
  const asking = status === "waiting";
  const canSend = !!session && !asking && !!text.trim();

  function send() {
    if (!canSend) return;
    const sent = text.trim();
    sendToTerminal(tab.id, sent);
    // Not crypto.randomUUID(), which a page that isn't a secure context
    // (plain http, as an iPad on Tailscale had) doesn't have: sending threw.
    setPending([...pending, { id: String(++pendingCount.current), text: sent, time: Date.now() }]);
    changeText("");
    // To the bottom, to see it go, from wherever you'd scrolled to.
    atBottom.current = true;
    pinned.current = false;
    scrolledTo.current = 0;
    const element = scroller();
    if (element) element.scrollTop = 0;
  }

  const pendingCount = useRef(0);

  // ⌃V (or ⌘V with only an image) puts the clipboard's image in Claude's
  // prompt, in the terminal, ahead of what you send from here.
  async function pasteImage() {
    const image = await pasteClipboardImage(tab.id);
    setNotice({
      id: (notice?.id ?? 0) + 1,
      text: image ? "Image pasted into Claude's prompt" : "No image on the clipboard",
    });
  }

  // Return is always a newline; ⌘Return sends.
  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Enter" && event.metaKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    } else if (isPasteImageKey(event)) {
      event.preventDefault();
      void pasteImage();
    } else if (isHideKey(event)) {
      event.preventDefault();
      hide();
    } else if (event.key === "Escape") {
      event.preventDefault();
      leave();
    }
  }

  // Another window's draft, unless you're writing here, where yours goes out next.
  useEffect(
    () =>
      daemon.onDraft((tabId, next) => {
        if (tabId !== tab.id) return;
        const field = composerRef.current?.querySelector("textarea");
        if (field && document.activeElement === field) return;
        setText(next);
        drafts.keep(tab, next);
      }),
    [tab.id],
  );

  const fileInput = useRef<HTMLInputElement>(null);
  const dictation = useDictation({
    onText: insert,
    onError: (error) => showToast({ title: "Couldn't dictate", message: error, destructive: true }),
  });

  // Photos and files, typed as their paths on the tab's Mac, as a drop's.
  async function attach(files: File[]) {
    if (files.length === 0) return;
    const attached = await attachedText(files, tab.id, showToast);
    if (attached) insert(attached);
  }

  async function onDrop(event: DragEvent) {
    const dropped = await droppedText(event, tab.id, showToast);
    if (dropped) insert(dropped);
  }

  // Selecting text in a message offers to quote it in your reply.
  function onMouseUp() {
    const selection = window.getSelection();
    const conversation = conversationRef.current;
    const selected = selection?.toString().trim();
    if (!selection || !conversation || !selected || selection.rangeCount === 0) return setQuote(null);
    if (!conversation.contains(selection.anchorNode) || !conversation.contains(selection.focusNode)) return setQuote(null);

    // In the conversation, which it scrolls with.
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const bounds = conversation.getBoundingClientRect();
    setQuote({
      text: selected,
      top: rect.top - bounds.top - 38,
      left: Math.min(Math.max(rect.left - bounds.left + rect.width / 2 - 52, 8), bounds.width - 124),
    });
  }

  // ⌃Q quotes too, wherever the keyboard is: before the terminal or the
  // composer can take it.
  useEffect(() => {
    if (!quote) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "q" || !event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      addQuote();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [quote, text]);

  function addQuote() {
    if (!quote) return;
    const quoted = quote.text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    setQuote(null);
    window.getSelection()?.removeAllRanges();
    changeText((text ? text.replace(/\n*$/, "\n\n") : "") + quoted + "\n\n");
    focusComposer();
  }

  // Where a jump (⌥↑ or ⌥↓) is scrolling to, until it gets there: pressing
  // again on the way goes on from there, not from wherever the scroll is.
  const jumpingTo = useRef<number | null>(null);

  /** Scrolls to the previous or next of your messages and final replies. */
  function jump(direction: -1 | 1) {
    const element = scroller();
    const conversation = conversationRef.current;
    if (!element || !conversation) return;

    // In scrollTops: 0 at the bottom, negative above.
    const from = jumpingTo.current ?? element.scrollTop;
    const top = element.clientHeight - element.scrollHeight;
    const stops = [...conversation.querySelectorAll<HTMLElement>(":scope > .prompt:not([data-pending]), :scope > .final-reply")]
      // A little above each, so it isn't flush with the top.
      .map((stop) => Math.min(Math.max(scrollTopFor(element, stop, 16), top), 0));
    const next =
      direction > 0 ? (stops.find((stop) => stop > from + 2) ?? 0) : (stops.findLast((stop) => stop < from - 2) ?? top);

    jumpingTo.current = next;
    element.scrollTo({ top: next, behavior: "smooth" });
  }

  // Code's copy buttons, code's menu, and links (which open in the browser).
  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (copyCode(target) || codeMenu.onClick(event)) return;
    const link = target.closest("a");
    if (link?.href) {
      event.preventDefault();
      openLink(link.href, tab.id);
    }
  }

  function placeholder(): string {
    if (!session) return "No Claude Code session";
    if (asking) return "Claude is asking something in the terminal";
    if (status === "working") return "Queue a message";
    return "Reply";
  }

  return (
    <>
      <BottomScrollable
        className="scroller"
        onScroll={(event) => {
          // Not hidden (a file showing instead), where it isn't you scrolling.
          if (!event.currentTarget.offsetParent) return;
          const top = event.currentTarget.scrollTop;
          scrollTop.current = top;
          if (Math.abs(top - scrolledTo.current) > 2) pinned.current = false;
          atBottom.current = top > -40;
        }}
        onScrollEnd={() => (jumpingTo.current = null)}
        // Focusable, so a click in the conversation puts the keyboard here,
        // where / goes to the composer, ⌥↑ and ⌥↓ jump between your messages
        // and replies (↑ and ↓ scroll, as a page's do; ⌥ as in moving by
        // paragraph), and Escape goes back to the terminal.
        tabIndex={-1}
        onKeyDown={(event) => {
          const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
          if (event.key === "/" && plain) {
            event.preventDefault();
            focusComposer();
          } else if (isPasteImageKey(event)) {
            event.preventDefault();
            void pasteImage();
          } else if (isHideKey(event)) {
            event.preventDefault();
            hide();
          } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
            event.preventDefault();
            jump(event.key === "ArrowUp" ? -1 : 1);
          } else if (event.key === "Escape") {
            event.preventDefault();
            leave();
          }
        }}
        onMouseUp={onMouseUp}
        onMouseDown={() => setQuote(null)}
        onClick={onClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <div className="conversation" ref={conversationRef}>
          {chat && !session && (
            <div className="note">Start Claude Code in this tab, and its conversation shows up here.</div>
          )}
          {chat && session && chat.entries.length === 0 && <div className="note">Nothing said yet.</div>}
          {group(chat?.entries ?? [], status === "working").map((item) =>
            item.kind === "tools" ? (
              <ToolCalls key={item.entries[0].id} entries={item.entries} />
            ) : item.kind === "prompt" ? (
              <div key={item.entry.id} className="prompt">
                <Bubble text={item.entry.text} />
              </div>
            ) : item.final ? (
              <Fragment key={item.entry.id}>
                <div className="final-reply">
                  Reply
                  {/* Only where there's a keyboard to press them on. */}
                  {autoFocus() && (
                    <span className="keys" {...tooltip("Jump between messages and replies", { delay: true })}>
                      ⌥↑ ⌥↓
                    </span>
                  )}
                </div>
                <Reply text={item.entry.text} />
              </Fragment>
            ) : (
              <Reply key={item.entry.id} text={item.entry.text} />
            ),
          )}
          {pending.map((sent) => (
            <div key={sent.id} className="prompt" data-pending>
              <Bubble text={sent.text} />
            </div>
          ))}
          {session && status === "working" && <div className="working">Working…</div>}
          {quote && (
            <button
              className="quote"
              style={{ top: quote.top, left: quote.left }}
              // Before the selection goes; and not to the conversation, whose
              // mousedown takes the button away (a click elsewhere) before
              // this click could land, and whose mouseup brings it back.
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onMouseUp={(event) => event.stopPropagation()}
              onClick={addQuote}
            >
              <TextQuote size={14} /> Quote <HotkeyView hotkeys={{ key: "ctrl+q" }} />
            </button>
          )}
        </div>
      </BottomScrollable>
      <form
        className="composer"
        ref={composerRef}
        onSubmit={(event) => {
          event.preventDefault();
          send();
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <Pill notice={notice} />
        <button
          type="button"
          className="tool attach"
          disabled={!session}
          {...tooltip("Attach files", { delay: true })}
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip size={19} />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void attach([...(event.target.files ?? [])]);
            event.target.value = "";
          }}
        />
        {/* While dictating, the waveform shows over the text, which keeps the
            focus (and so the on-screen keyboard). */}
        <div className="field" data-dictating={!!dictation.stream}>
          <TextArea
            value={text}
            onValueChange={changeText}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              // An image and no text: what Claude takes is the image.
              const { clipboardData } = event;
              if (clipboardData.getData("text/plain") || ![...clipboardData.items].some((item) => item.type.startsWith("image/"))) return;
              event.preventDefault();
              void pasteImage();
            }}
            placeholder={placeholder()}
            disabled={!session}
            autoSizing
            minHeight={20}
            maxHeight={240}
            rows={1}
          />
          {dictation.stream && <Waveform stream={dictation.stream} />}
        </div>
        <button
          type="button"
          className="tool dictate"
          data-state={dictation.state}
          disabled={!session || dictation.state === "transcribing"}
          {...tooltip(dictation.state === "recording" ? "Stop dictating" : "Dictate", { delay: true })}
          onClick={dictation.toggle}
        >
          {dictation.state === "transcribing" ? <LoaderCircle size={18} /> : dictation.state === "recording" ? <Square size={11} fill="currentColor" /> : <Mic size={19} />}
        </button>
        {status === "working" && !text ? (
          <button
            type="button"
            className="send"
            {...tooltip("Stop", { delay: true })}
            onClick={() => sendEscape(tab.id)}
            // As Send below: the field keeps focus, so the keyboard stays up.
            onMouseDown={(event) => event.preventDefault()}
            onTouchEnd={(event) => {
              event.preventDefault();
              sendEscape(tab.id);
            }}
          >
            <Square size={12} fill="currentColor" />
          </button>
        ) : (
          <button
            type="submit"
            className="send"
            {...tooltip("Send", { hotkey: "cmd+Enter", delay: true })}
            disabled={!canSend}
            // The field keeps focus, so on a touch screen the keyboard stays
            // up for the next message: a tap would take focus from it first.
            onMouseDown={(event) => event.preventDefault()}
            onTouchEnd={(event) => {
              event.preventDefault();
              composerRef.current?.requestSubmit();
            }}
          >
            <ArrowUp size={16} />
          </button>
        )}
      </form>
    </>
  );
}

/** The scrollTop that puts `element` `margin` below the scroller's top. */
function scrollTopFor(scroller: HTMLElement, element: HTMLElement, margin: number): number {
  return scroller.scrollTop + element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin;
}

/** The start of the words the conversation ends with (its "Reply" line, if marked), if it does. */
function replyStart(conversation: HTMLElement): HTMLElement | null {
  let start: HTMLElement | null = null;
  for (let child = conversation.lastElementChild; child; child = child.previousElementSibling) {
    if (child.matches(".working, .quote")) continue;
    if (!child.matches(".reply, .final-reply")) break;
    start = child as HTMLElement;
  }
  return start;
}

/** One of your messages, in markdown too, its line breaks as you typed them. A long one (a paste) shows its start, until you ask for more. */
function Bubble({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Measured as laid out, and again as the panel's width changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => element.offsetParent && setLong(element.scrollHeight > BUBBLE_LONG);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="bubble" data-clamped={long && !expanded}>
      <div ref={ref} className="text" dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { breaks: true }) }} />
      {long && (
        <button type="button" className="more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

/** How tall a message of yours shows (about 10 lines), and how tall it can be before it's cut to that. */
const BUBBLE_CLAMPED = 210;
const BUBBLE_LONG = 320;

function Reply({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);

  // A copy button on each block of code.
  useLayoutEffect(() => {
    addCopyButtons(ref.current?.querySelectorAll<HTMLPreElement>(":scope > pre") ?? []);
  }, [html]);

  return <div className="reply" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** A run of tool calls: one line, which opens to a line each, which open to their details. */
function ToolCalls({ entries }: { entries: Extract<ChatEntry, { kind: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  const [openDetail, setOpenDetail] = useState<string | null>(null);

  const counts = new Map<string, number>();
  for (const entry of entries) counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  const names = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");
  const only = entries.length === 1 ? entries[0] : null;

  return (
    <div className="tools" data-open={open}>
      <button className="tools-line" onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="chevron" />
        <span className="names">{names}</span>
        {only && !open && <span className="summary">{only.summary}</span>}
      </button>
      {open &&
        entries.map((entry) => (
          <div key={entry.id} className="tool">
            <button
              className="tool-line"
              disabled={!entry.detail}
              onClick={() => setOpenDetail(openDetail === entry.id ? null : entry.id)}
            >
              <span className="name">{entry.name}</span>
              <span className="summary">{entry.summary}</span>
            </button>
            {openDetail === entry.id && entry.detail && <pre className="detail">{entry.detail}</pre>}
          </div>
        ))}
    </div>
  );
}

const StyledChatPanel = styled.div`
  position: relative;
  display: flex;
  flex-flow: column;
  min-height: 0;
  background: ${colors.textBackgroundPanel()};
  color: ${colors.text()};
  font: ${fonts.display({ size: 14, line: "23px" })};
  ${padSafeArea("right", "bottom")}

  /* Whichever isn't showing stays, hidden, so it's as you left it. */
  &:not([data-showing="chat"]) > .scroller,
  &:not([data-showing="chat"]) > .composer,
  &:not([data-showing="chat"]) > .note,
  > .file-view[hidden] {
    display: none;
  }

  /* A page hidden keeps its size: a webview shrunk to nothing (display:
     none) lays its page out again, at nothing, and back. */
  &:not([data-showing="page"]) > .page-view {
    position: absolute;
    inset: 0;
    visibility: hidden;
    pointer-events: none;
  }

  > .file-view,
  > .page-view {
    flex-grow: 1;
    min-height: 0;
    display: flex;
    flex-flow: column;
  }

  /* Like the tab bar's tabs, with the showing one's controls at the end. */
  > .switcher {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 10px 7px 12px;
    border-bottom: 1px solid ${colors.separator()};

    > .views {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      /* Files enough to run past its end: it scrolls, sideways. */
      overflow-x: auto;
      scrollbar-width: none;
    }

    > .tools {
      flex-shrink: 0;
      display: flex;

      &:empty {
        display: none;
      }
    }
  }

  > .note,
  > .scroller > .conversation > .note {
    padding: 24px;
    color: ${colors.textSecondary()};
    text-align: center;
  }

  > .scroller {
    flex-grow: 1;
    outline: none;
    min-height: 0;
  }

  > .scroller > .conversation {
    position: relative;
    padding: 16px 18px 8px;
    display: flex;
    flex-flow: column;
    gap: 14px;

    > * {
      flex-shrink: 0;
    }

    > .prompt {
      display: flex;
      justify-content: flex-end;
      padding-left: 36px;

      &[data-pending] {
        opacity: 0.55;
      }

      > .bubble {
        min-width: 0;
        overflow-wrap: anywhere;
        padding: 8px 12px;
        border-radius: 14px;
        /* Your own words: no need for the replies' roomier lines. */
        font: ${fonts.display({ size: 14, line: "21px" })};
        background: ${colors.darkBlue()};
        color: ${colors.white()};

        ::selection {
          background: ${colors.white({ alpha: 0.35 })};
        }

        > .text > *:first-child {
          margin-top: 0;
        }
        > .text > *:last-child {
          margin-bottom: 0;
        }

        &[data-clamped="true"] > .text {
          max-height: ${BUBBLE_CLAMPED}px;
          overflow: hidden;
          mask-image: linear-gradient(to bottom, black 60%, transparent);
        }

        > .more {
          display: block;
          margin: 4px 0 0 auto;
          padding: 0;
          border: none;
          background: none;
          font: ${fonts.displayBold({ size: 13, line: "20px" })};
          color: ${colors.white({ alpha: 0.85 })};
          cursor: pointer;

          &:hover {
            color: ${colors.white()};
          }
        }

        p,
        ul,
        ol,
        blockquote,
        pre,
        table {
          margin: 0 0 8px;
        }

        ul,
        ol {
          padding-left: 20px;
        }

        h1,
        h2,
        h3,
        h4 {
          margin: 10px 0 6px;
          font: ${fonts.displayBold({ size: 15, line: "21px" })};
        }

        a {
          color: inherit;
          text-underline-offset: 2px;
        }

        blockquote {
          padding-left: 10px;
          border-left: 3px solid ${colors.white({ alpha: 0.45 })};
          color: ${colors.white({ alpha: 0.85 })};
        }

        hr {
          border: none;
          border-top: 1px solid ${colors.white({ alpha: 0.35 })};
          margin: 10px 0;
        }

        /* On the blue, white throughout: the replies' code colors are for a light page. */
        code {
          font: ${fonts.displayMono({ size: 12.5, line: "18px" })};
          color: inherit;

          * {
            color: inherit;
          }
        }

        code:not(pre > code) {
          padding: 1px 4px;
          border-radius: 4px;
          background: ${colors.white({ alpha: 0.18 })};
        }

        pre {
          padding: 8px 10px;
          border-radius: 8px;
          background: ${colors.black({ alpha: 0.2 })};
          overflow-x: auto;
          overflow-wrap: normal;
        }

        table {
          border-collapse: collapse;
          display: block;
          overflow-x: auto;
          max-width: 100%;

          th,
          td {
            padding: 3px 8px;
            text-align: left;
            border: 1px solid ${colors.white({ alpha: 0.35 })};
          }
        }
      }
    }

    > .reply {
      overflow-wrap: break-word;
      user-select: text;

      ${markdownCSS()}

      /* Code in a message opens a menu (codeMenu.tsx); a link's is the link. */
      code:not(pre > code, a code) {
        cursor: pointer;

        &:hover {
          border-color: ${colors.textSecondary({ alpha: 0.5 })};
        }
      }
    }

    > .tools {
      margin: -4px 0;
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};

      button {
        display: flex;
        /* The name and its summary are in different fonts: line them up by
           their text, not their boxes. */
        align-items: baseline;
        gap: 6px;
        width: 100%;
        min-width: 0;
        padding: 2px 0;
        border: none;
        background: none;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;

        &:disabled {
          cursor: default;
        }
      }

      /* On the first line, should the names wrap. */
      .chevron {
        flex-shrink: 0;
        align-self: flex-start;
        margin-top: 2.5px;
        transition: transform 0.15s;
      }

      &[data-open="true"] .chevron {
        transform: rotate(90deg);
      }

      /* Names wrap, inside one if need be (an MCP tool's has nowhere to
         break): never wider than the panel, or it scrolls sideways. A
         summary gets what's left. */
      .names,
      .name {
        min-width: 0;
        overflow-wrap: anywhere;
        font: ${fonts.displayMedium({ size: 12, line: "18px" })};
      }

      .summary {
        flex: 1 1 0;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: ${fonts.displayMono({ size: 11.5, line: "18px" })};
      }

      > .tool {
        padding-left: 19px;

        > .detail {
          margin: 2px 0 6px;
          padding: 8px 10px;
          max-height: 300px;
          overflow: auto;
          border-radius: 6px;
          background: ${colors.textBackground()};
          border: 1px solid ${colors.separator()};
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          font: ${fonts.displayMono({ size: 11.5, line: "16px" })};
        }
      }
    }

    /* Where the turn's final reply starts, so you know where to stop
       scrolling up. */
    > .final-reply {
      display: flex;
      align-items: center;
      gap: 8px;
      /* Room above, so it stands out while you scroll. */
      margin: 18px 0 -4px;
      font: ${fonts.displayMedium({ size: 11, line: "14px" })};
      ${accentColor()}

      &::after {
        content: "";
        flex-grow: 1;
        border-top: 1px solid currentColor;
        opacity: 0.4;
      }

      /* After the line, quietly. */
      > .keys {
        order: 1;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 11, line: "14px" })};
        opacity: 0.7;
        cursor: default;
      }
    }

    > .working {
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};
    }

    > .quote {
      position: absolute;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 10px;
      border-radius: 14px;
      border: 1px solid ${colors.separator()};
      background: ${colors.textBackground()};
      color: ${colors.text()};
      font: ${fonts.displayMedium({ size: 12, line: "16px" })};
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
      cursor: pointer;

      > ${StyledHotkeyView} {
        margin-left: 2px;
        font: ${fonts.displayBold({ size: 11, line: "16px" })};
      }
    }
  }

  > .composer {
    position: relative;
    flex-shrink: 0;
    display: flex;
    align-items: flex-end;
    gap: 6px;
    margin: 6px 12px 12px;
    padding: 6px 6px 6px 12px;
    border-radius: 16px;
    border: 1px solid ${colors.separator()};
    background: ${colors.textBackground()};

    &:focus-within {
      border-color: ${colors.textSecondary({ alpha: 0.5 })};
    }

    > .field {
      position: relative;
      flex-grow: 1;
      min-width: 0;
      align-self: center;

      &[data-dictating="true"] > ${StyledTextArea} {
        opacity: 0;
      }

      > ${StyledWaveform} {
        position: absolute;
        inset: 0;
        height: auto;
      }
    }

    > .field > ${StyledTextArea} {
      > textarea {
        display: block;
        width: 100%;
        padding: 0;
        border: none;
        outline: none;
        resize: none;
        background: transparent;
        color: ${colors.text()};
        font: ${fonts.display({ size: 14, line: "20px" })};
      }
    }

    > .tool {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      border: none;
      background: transparent;
      color: ${colors.textSecondary()};
      cursor: pointer;

      &:disabled {
        opacity: 0.35;
        cursor: default;
      }

      &.attach {
        /* Sits against the field's own left padding. */
        margin-left: -6px;
      }

      &[data-state="recording"] {
        background: #e5484d;
        color: #fff;
        animation: dictating 1.2s ease-in-out infinite;
      }

      &[data-state="transcribing"] > svg {
        animation: spin 0.9s linear infinite;
      }
    }

    @keyframes dictating {
      50% {
        opacity: 0.7;
      }
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    > .send {
      flex-shrink: 0;
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 14px;
      border: none;
      background: ${colors.text()};
      color: ${colors.textBackground()};
      cursor: pointer;

      &:disabled {
        opacity: 0.25;
        cursor: default;
      }
    }

    /* Finger-sized, with their icons a size up. */
    ${coarsePointer(`
      align-items: center;

      > .tool,
      > .send {
        width: 40px;
        height: 40px;
        border-radius: 20px;

        > svg {
          width: 22px;
          height: 22px;
        }
      }

      > .tool[data-state="recording"] > svg {
        width: 14px;
        height: 14px;
      }

      /* Filled, it reads bigger than the bare icons beside it at the same size. */
      > .send {
        width: 34px;
        height: 34px;
        border-radius: 17px;
        margin: 3px;

        > svg {
          width: 18px;
          height: 18px;
        }
      }
    `)}
  }
`;
