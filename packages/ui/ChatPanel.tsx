import { colors } from "crosswing/colors";
import { PanelLayout, PanelLayoutContext, StyledPanelLayout } from "crosswing/components/PanelLayout";
import { StyledTextArea, TextArea } from "crosswing/components/forms/TextArea";
import { fonts } from "crosswing/fonts";
import { ModalContext } from "crosswing/modals/context";
import { HotkeyView, StyledHotkeyView } from "crosswing/modals/popup/HotkeyView";
import { tooltip } from "crosswing/modals/popup";
import { ArrowUp, ChevronRight, Square, TextQuote } from "lucide-react";
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
import { daemon } from "./daemon";
import { FileView } from "./FileView";
import { highlightCSS, renderMarkdown, taskListCSS } from "./markdown";
import { type Notice, Pill } from "./Pill";
import { autoFocus, useSettings } from "./settings";
import {
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
 * across relaunches and daemon restarts. In this window's storage: a draft is
 * this Mac's, and lost if it can't be kept, nothing worse.
 */
const drafts = {
  get(tab: Tab): string {
    try {
      return localStorage.getItem(`ChatPanel:draft:${keyOf(tab)}`) ?? "";
    } catch {
      return "";
    }
  },
  set(tab: Tab, text: string) {
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

export const isChatOpen = openTabs.has;
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
  if (open) focusOnShow = true;
  else focusActiveTerminal();
  setChatOpen(tab, open);
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
  const { page } = tab;
  const files = openFiles(tab);
  const visible = panelOpen && hasPanel(tab);
  // Which of what it has the panel shows: what you picked, or else the
  // latest to open (a page, then a file, then the conversation).
  const [view, setView] = useState<PanelView>("page");
  const views = panelViews(tab);
  const showing: PanelView = views.includes(view) ? view : (views.at(-1) ?? "chat");
  const ref = useRef<HTMLDivElement>(null);

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
      if (!isChatOpen(tab)) {
        openedForContent.current = true;
        setChatOpen(tab, true);
      }
    } else if (files.length === 0 && !page && openedForContent.current && (before.files.size > 0 || before.page)) {
      openedForContent.current = false;
      setChatOpen(tab, false);
    }
  }, [files.map((file) => `${file.id}.${file.opened ?? 0}`).join(), page?.id]);

  // Coming back to the tab, the keyboard goes back where it was: into the
  // panel, if it was there. And always into the panel when it covers the
  // terminal. Where it was is read first (layout effects run before the
  // rest), because the terminal takes the keyboard as it comes on screen,
  // which would record that instead; this puts it back after.
  const returnTo = useRef<PanelPlace | undefined>(undefined);
  useLayoutEffect(() => {
    returnTo.current = active ? panelFocus.get(tab.id) : undefined;
  }, [active]);

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
          setChatOpen(tab, open);
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
          visible={visible}
          supported={supported}
          showing={showing}
          onShow={setView}
          onHide={() => {
            setChatOpen(tab, false);
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
const panelViews = (tab: Tab): PanelView[] => [
  ...(tab.agent ? (["chat"] as const) : []),
  ...openFiles(tab).map((file) => `file:${file.id}` as const),
  ...(tab.page ? (["page"] as const) : []),
];

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

/**
 * The tab's Claude Code conversation, for reading in proportional type with
 * real markdown, and a place to write the next message. Everything here is
 * read from the session's transcript (the daemon follows it), and a message
 * sent from here is typed into the terminal, so the terminal stays the
 * truth: this is another view of it.
 */
export function ChatPanel({
  tab,
  visible,
  supported,
  showing,
  onShow,
  onHide,
  focusFile,
}: {
  tab: Tab;
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
  const views = panelViews(tab);
  const files = openFiles(tab);
  const fileOf = (view: PanelView) => files.find((file) => view === `file:${file.id}`);
  const label = (view: PanelView) =>
    view === "chat" ? "Chat" : view === "page" ? pageTitle || hostOf(tab.page?.url) : fileOf(view)?.path.split("/").pop();

  return (
    // Its text grows and shrinks with the terminal's (⌘= and ⌘-), through
    // the font scale crosswing's fonts all follow.
    <StyledChatPanel
      data-showing={showing.startsWith("file:") ? "file" : showing}
      style={{ "--font-scale": fontSize / DEFAULT_SETTINGS.fontSize } as CSSProperties}
    >
      {views.length > 1 && (
        <div className="switcher">
          {views.map((view) => (
            <button key={view} data-on={showing === view} title={fileOf(view)?.path} onClick={() => onShow(view)}>
              {label(view)}
            </button>
          ))}
        </div>
      )}
      {tab.agent && supported && <Conversation tab={tab} visible={visible} />}
      {tab.agent && !supported && (
        <div className="note">This tab's Mac has an older Miks. Update it there to see conversations here.</div>
      )}
      {files.map((file) => (
        <div key={file.id} className="file-view" hidden={showing !== `file:${file.id}`}>
          <FileView tab={tab} file={file} focusOnOpen={focusFile && file.edit} onHide={onHide} />
        </div>
      ))}
      {tab.page && (
        <div className="page-view">
          <BrowseView tab={tab} page={tab.page} onTitle={setPageTitle} />
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

function Conversation({ tab, visible }: { tab: Tab; visible: boolean }) {
  const [chat, setChat] = useState<{ session: string | null; entries: ChatEntry[] } | null>(null);
  const [text, setText] = useState(drafts.get(tab));
  // Sent from here and not yet in the transcript: shown right away, faded.
  const [pending, setPending] = useState<{ id: string; text: string; time: number }[]>([]);
  const [quote, setQuote] = useState<{ text: string; top: number; left: number } | null>(null);
  // What ⌃V did, above the composer.
  const [notice, setNotice] = useState<Notice | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLFormElement>(null);
  const atBottom = useRef(true);
  // Where following stopped to keep a reply's start on screen (see below).
  const pinnedAt = useRef<number | null>(null);
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

  // New messages keep it at the bottom, unless you've scrolled up to read.
  // But not past the start of the words it ends with: you watch tool calls
  // go by, then read the reply from its top. Whether words are the turn's
  // last isn't known until it ends, so any are; a tool call after them
  // carries on to the bottom. Not for one loaded all at once (opening Miks
  // again), which was read as it went, if at all, and goes to the bottom.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const wasLoaded = loaded.current;
    loaded.current = false;
    if (!scroller || !atBottom.current) return;
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    const start = wasLoaded ? null : replyStart(scroller);
    const target = start ? Math.max(Math.min(bottom, start.offsetTop - 12), scroller.scrollTop) : bottom;
    pinnedAt.current = target < bottom - 1 ? target : null;
    scroller.scrollTop = target;
  }, [chat, pending, status]);

  // ⌃D hides the panel for the terminal, where two more quit Claude Code.
  function hide() {
    setChatOpen(tab, false);
    focusActiveTerminal();
  }

  // Escape goes back to the terminal; over it, there's no getting to it but
  // by closing the panel.
  const { panelMode } = use(PanelLayoutContext);
  function leave() {
    if (panelMode === "overlay" || expandedTabs.has(tab)) setChatOpen(tab, false);
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

  function insert(addition: string) {
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
    atBottom.current = true;
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

  async function onDrop(event: DragEvent) {
    const dropped = await droppedText(event, tab.id, showToast);
    if (dropped) insert(dropped);
  }

  // Selecting text in a message offers to quote it in your reply.
  function onMouseUp() {
    const selection = window.getSelection();
    const scroller = scrollerRef.current;
    const selected = selection?.toString().trim();
    if (!selection || !scroller || !selected || selection.rangeCount === 0) return setQuote(null);
    if (!scroller.contains(selection.anchorNode) || !scroller.contains(selection.focusNode)) return setQuote(null);

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const bounds = scroller.getBoundingClientRect();
    setQuote({
      text: selected,
      top: rect.top - bounds.top + scroller.scrollTop - 38,
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

  // Where a jump (↑ or ↓) is scrolling to, until it gets there: pressing
  // again on the way goes on from there, not from wherever the scroll is.
  const jumpingTo = useRef<number | null>(null);

  /** Scrolls to the previous or next of your messages and final replies. */
  function jump(direction: -1 | 1) {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const from = jumpingTo.current ?? scroller.scrollTop;
    const stops = [...scroller.querySelectorAll<HTMLElement>(":scope > .prompt:not([data-pending]), :scope > .final-reply")]
      // A little above each, so it isn't flush with the top.
      .map((stop) => Math.max(stop.offsetTop - 16, 0));
    const bottom = scroller.scrollHeight - scroller.clientHeight;
    const next =
      direction > 0 ? (stops.find((top) => top > from + 2) ?? bottom) : (stops.findLast((top) => top < from - 2) ?? 0);

    const target = Math.min(next, bottom);
    jumpingTo.current = target;
    scroller.scrollTo({ top: target, behavior: "smooth" });
  }

  // Code's copy buttons, and links (which open in the browser).
  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    const copy = target.closest("button.copy");
    if (copy) {
      const code = copy.parentElement?.querySelector("pre")?.textContent ?? "";
      window.miks?.copy(code);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const link = target.closest("a");
    if (link?.href) {
      event.preventDefault();
      window.open(link.href);
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
      <div
        className="scroller"
        ref={scrollerRef}
        onScroll={(event) => {
          const scroller = event.currentTarget;
          const pinned = pinnedAt.current !== null && Math.abs(scroller.scrollTop - pinnedAt.current) < 2;
          if (!pinned) pinnedAt.current = null;
          atBottom.current = pinned || scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
        }}
        onScrollEnd={() => (jumpingTo.current = null)}
        // Focusable, so a click in the conversation puts the keyboard here,
        // where / goes to the composer, ↑ and ↓ jump between your messages
        // and replies, and Escape goes back to the terminal.
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
          } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && plain) {
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
              <div className="final-reply">Reply</div>
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
        {status === "working" && !text ? (
          <button type="button" className="send" {...tooltip("Stop", { delay: true })} onClick={() => sendEscape(tab.id)}>
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

/** The start of the words the conversation ends with (its "Reply" line, if marked), if it does. */
function replyStart(scroller: HTMLElement): HTMLElement | null {
  let start: HTMLElement | null = null;
  for (let child = scroller.lastElementChild; child; child = child.previousElementSibling) {
    if (child.matches(".working, .quote")) continue;
    if (!child.matches(".reply, .final-reply")) break;
    start = child as HTMLElement;
  }
  return start;
}

/** One of your messages, in markdown too, its line breaks as you typed them. */
function Bubble({ text }: { text: string }) {
  return <div className="bubble" dangerouslySetInnerHTML={{ __html: renderMarkdown(text, { breaks: true }) }} />;
}

function Reply({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text);

  // A copy button on each block of code.
  useLayoutEffect(() => {
    for (const pre of ref.current?.querySelectorAll(":scope > pre") ?? []) {
      const wrapper = document.createElement("div");
      wrapper.className = "code";
      pre.replaceWith(wrapper);
      const button = document.createElement("button");
      button.className = "copy";
      button.textContent = "Copy";
      wrapper.append(pre, button);
    }
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

  > .switcher {
    flex-shrink: 0;
    display: flex;
    gap: 4px;
    padding: 8px 12px 0;
    /* Files enough to run past its end: it scrolls, sideways. */
    overflow-x: auto;
    scrollbar-width: none;

    > button {
      flex-shrink: 0;
      max-width: 60%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      height: 26px;
      padding: 0 12px;
      border: none;
      border-radius: 13px;
      background: transparent;
      color: ${colors.textSecondary()};
      font: ${fonts.displayMedium({ size: 12, line: "16px" })};
      cursor: pointer;

      &[data-on="true"] {
        background: ${colors.buttonBackgroundGlow()};
        color: ${colors.text()};
      }

      ${coarsePointer(`
        height: 34px;
        padding: 0 14px;
        border-radius: 17px;
        font-size: 14px;
      `)}
    }
  }

  > .note,
  > .scroller > .note {
    padding: 24px;
    color: ${colors.textSecondary()};
    text-align: center;
  }

  > .scroller {
    flex-grow: 1;
    outline: none;
    min-height: 0;
    overflow-y: auto;
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

        > *:first-child {
          margin-top: 0;
        }
        > *:last-child {
          margin-bottom: 0;
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

      > *:first-child {
        margin-top: 0;
      }
      > *:last-child {
        margin-bottom: 0;
      }

      p,
      ul,
      ol,
      blockquote,
      table,
      > .code {
        margin: 0 0 10px;
      }

      ul,
      ol {
        padding-left: 22px;
      }

      /* Items often run to a few lines each: a gap tells them apart. */
      li + li {
        margin-top: 8px;
      }

      li > ul,
      li > ol {
        margin: 4px 0;
      }

      ${taskListCSS()}

      h1,
      h2,
      h3,
      h4 {
        margin: 16px 0 8px;
      }
      h1 {
        font: ${fonts.displayBold({ size: 20, line: "26px" })};
      }
      h2 {
        font: ${fonts.displayBold({ size: 17, line: "23px" })};
      }
      h3,
      h4 {
        font: ${fonts.displayBold({ size: 15, line: "21px" })};
      }

      /* Quieter than the prose, like the tool lines. */
      a {
        color: ${colors.textSecondary()};
        text-decoration-color: ${colors.textSecondary({ alpha: 0.4 })};
        text-underline-offset: 2px;
      }

      blockquote {
        padding-left: 12px;
        border-left: 3px solid ${colors.separator()};
        color: ${colors.textSecondary()};
      }

      hr {
        border: none;
        border-top: 1px solid ${colors.separator()};
        margin: 14px 0;
      }

      > .code {
        position: relative;

        > pre {
          margin: 0;
        }

        > .copy {
          position: absolute;
          top: 6px;
          right: 6px;
          padding: 2px 8px;
          border-radius: 6px;
          border: 1px solid ${colors.separator()};
          background: ${colors.textBackground()};
          color: ${colors.textSecondary()};
          font: ${fonts.display({ size: 11, line: "16px" })};
          cursor: pointer;
          opacity: 0;
          transition: opacity 0.15s;
        }

        &:hover > .copy {
          opacity: 1;
        }
      }

      pre {
        background: ${colors.textBackground()};
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid ${colors.separator()};
        overflow-x: auto;
        font: ${fonts.displayMono({ size: 12, line: "18px" })};
      }

      code:not(pre > code) {
        padding: 1px 4px;
        border-radius: 4px;
        background: ${colors.textBackground()};
        border: 1px solid ${colors.separator()};
        overflow-wrap: anywhere;
        font: ${fonts.displayMono({ size: 12.5, line: "18px" })};
        /* Blue-violet, so code stands out from the prose around it. */
        color: #5b4fd1;

        @media (prefers-color-scheme: dark) {
          color: #a8a0ff;
        }
      }

      table {
        border-collapse: collapse;
        display: block;
        overflow-x: auto;
        max-width: 100%;
        font: ${fonts.display({ size: 13, line: "19px" })};

        th,
        td {
          padding: 4px 8px;
          text-align: left;
          vertical-align: top;
          border: 1px solid ${colors.separator()};
        }

        th {
          font: ${fonts.displayBold({ size: 13, line: "19px" })};
          background: ${colors.textBackgroundAlt()};
        }
      }

      ${highlightCSS()}
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

      .chevron {
        flex-shrink: 0;
        align-self: center;
        transition: transform 0.15s;
      }

      &[data-open="true"] .chevron {
        transform: rotate(90deg);
      }

      .names,
      .name {
        flex-shrink: 0;
        font: ${fonts.displayMedium({ size: 12, line: "18px" })};
      }

      .summary {
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
      color: #5b4fd1;
      font: ${fonts.displayMedium({ size: 11, line: "14px" })};

      @media (prefers-color-scheme: dark) {
        color: #a8a0ff;
      }

      &::after {
        content: "";
        flex-grow: 1;
        border-top: 1px solid currentColor;
        opacity: 0.4;
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

    > ${StyledTextArea} {
      flex-grow: 1;
      min-width: 0;
      align-self: center;

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
  }
`;
