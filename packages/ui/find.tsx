import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createGlobalStyle, styled } from "styled-components";

/** What ⌘F tells the view that has the keyboard, by an event on its `data-find` element. */
const FIND_EVENT = "miks-find";

/**
 * ⌘F goes to what has the keyboard: its element with `data-find` (a chat, a
 * rendered markdown file, a terminal), or else the terminal on screen.
 * CodeMirror's own (files as code, and in the editor) stays its own. Not ⌃F,
 * which is a terminal program's.
 */
export function listenForFind() {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "f" || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const focused = document.activeElement;
    if (focused?.closest(".cm-editor")) return;
    const host = focused?.closest("[data-find]") ?? document.querySelector('[data-find="terminal"][data-active="true"]');
    if (!host) return;
    event.preventDefault();
    event.stopPropagation();
    host.dispatchEvent(new CustomEvent(FIND_EVENT));
  };
  window.addEventListener("keydown", onKeyDown, { capture: true });
  return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
}

/** Calls `show` when ⌘F is for any of these elements. */
export function onFind(elements: (Element | null | undefined)[], show: () => void) {
  const present = elements.filter((element) => !!element);
  for (const element of present) element.addEventListener(FIND_EVENT, show);
  return () => {
    for (const element of present) element.removeEventListener(FIND_EVENT, show);
  };
}

/** Puts the keyboard in the find field, for ⌘F while its bar is already open. */
export function focusFind(input: HTMLInputElement | null) {
  input?.focus();
  input?.select();
}

/**
 * The find bar, which takes the keyboard as it opens. Enter and ⇧Enter step, Escape closes; those stay here, since
 * what's around it takes them for its own.
 */
export function FindBar({
  inputRef,
  query,
  status,
  onQuery,
  onStep,
  onClose,
  style,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  query: string;
  /** "3 of 12", or "No results". */
  status: string;
  onQuery: (query: string) => void;
  onStep: (direction: 1 | -1) => void;
  onClose: () => void;
  style?: CSSProperties;
}) {
  useLayoutEffect(() => focusFind(inputRef.current), []);

  return (
    <StyledFindBar className="find-bar" style={style}>
      <FindHighlights />
      <input
        ref={inputRef}
        value={query}
        placeholder="Find"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") onStep(event.shiftKey ? -1 : 1);
          else onClose();
        }}
      />
      <span className="status">{status}</span>
      {/* Keeping the keyboard in the field. */}
      <button type="button" aria-label="Previous" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep(-1)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" aria-label="Next" onMouseDown={(event) => event.preventDefault()} onClick={() => onStep(1)}>
        <ChevronDown size={16} />
      </button>
      <button type="button" aria-label="Close" onMouseDown={(event) => event.preventDefault()} onClick={onClose}>
        <X size={16} />
      </button>
    </StyledFindBar>
  );
}

const FindHighlights = createGlobalStyle`
  ::highlight(miks-find) {
    background-color: rgb(255 214 0 / 0.4);
  }

  ::highlight(miks-find-current) {
    background-color: rgb(255 150 0 / 0.85);
    color: #000;
  }
`;

const StyledFindBar = styled.div`
  position: absolute;
  top: 8px;
  right: 12px;
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 2px;
  max-width: calc(100% - 24px);
  box-sizing: border-box;
  padding: 4px;
  border: 1px solid ${colors.separator()};
  border-radius: 9px;
  background: ${colors.textBackgroundPanel()};
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.2);

  > input {
    flex: 0 1 170px;
    min-width: 60px;
    padding: 3px 6px;
    border: none;
    outline: none;
    background: transparent;
    color: ${colors.text()};
    font: ${fonts.display({ size: 13 })};
  }

  > .status {
    flex-shrink: 0;
    padding: 0 6px;
    color: ${colors.textSecondary()};
    font: ${fonts.display({ size: 12 })};
  }

  > button {
    flex-shrink: 0;
    display: flex;
    padding: 4px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: ${colors.textSecondary()};

    &:hover {
      background: ${colors.buttonBackgroundGlow()};
      color: ${colors.text()};
    }
  }
`;

/** What `::highlight` is showing belongs to one find at a time, the last to search. */
let painter: object | null = null;

function paint(owner: object, matches: Range[], current: number) {
  painter = owner;
  CSS.highlights?.set("miks-find", new Highlight(...matches));
  CSS.highlights?.set("miks-find-current", new Highlight(...(matches[current] ? [matches[current]] : [])));
}

function unpaint(owner: object) {
  if (painter !== owner) return;
  painter = null;
  CSS.highlights?.delete("miks-find");
  CSS.highlights?.delete("miks-find-current");
}

/**
 * Every place `query` appears in what's shown under `root`, ignoring case,
 * across the elements inside a line (`inline code`, say). Nothing in the page
 * changes for it: ranges, drawn by the CSS Custom Highlight API.
 */
export function findInElement(root: HTMLElement, query: string): Range[] {
  if (!query) return [];
  const nodes: { node: Text; start: number }[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.checkVisibility()) continue;
    nodes.push({ node, start: text.length });
    text += node.data;
  }

  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  // Lowercasing can change a text's length (İ), and then offsets are wrong.
  if (haystack.length !== text.length) return [];

  const ranges: Range[] = [];
  let index = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) {
    const end = at + needle.length;
    while (nodes[index + 1] && nodes[index + 1].start <= at) index++;
    let last = index;
    while (nodes[last + 1] && nodes[last + 1].start < end) last++;
    const range = document.createRange();
    range.setStart(nodes[index].node, at - nodes[index].start);
    range.setEnd(nodes[last].node, end - nodes[last].start);
    ranges.push(range);
  }
  return ranges;
}

/**
 * Find over what's in an element: `show` opens it, `bar` is the bar to render
 * (null while closed). It searches again as the content changes (a reply
 * arriving), staying on the match it was on, as near as it can.
 */
export function useFind(root: () => HTMLElement | null, { onClose, style }: { onClose?: () => void; style?: CSSProperties } = {}) {
  const owner = useRef({}).current;
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState({ count: 0, current: 0 });
  const matches = useRef<Range[]>([]);
  const current = useRef(0);

  function select(index: number, scroll: boolean) {
    current.current = index;
    paint(owner, matches.current, index);
    setResult({ count: matches.current.length, current: index });
    if (scroll) matches.current[index]?.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
  }

  function search(text: string, scroll: boolean) {
    const element = root();
    matches.current = element ? findInElement(element, text) : [];
    select(Math.min(current.current, Math.max(matches.current.length - 1, 0)), scroll);
  }

  useEffect(() => {
    const element = root();
    if (!open || !element) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => search(query, false), 150);
    });
    observer.observe(element, { subtree: true, childList: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, query]);

  useEffect(() => () => unpaint(owner), []);

  const show = () => {
    setOpen(true);
    focusFind(inputRef.current);
    if (query) search(query, false);
  };

  const close = () => {
    setOpen(false);
    unpaint(owner);
    onClose?.();
  };

  const count = result.count;
  const bar = open ? (
    <FindBar
      inputRef={inputRef}
      query={query}
      status={!query ? "" : count ? `${result.current + 1} of ${count}` : "No results"}
      onQuery={(text) => {
        setQuery(text);
        current.current = 0;
        search(text, true);
      }}
      onStep={(direction) => count && select((current.current + direction + count) % count, true)}
      onClose={close}
      style={style}
    />
  ) : null;

  return { show, bar };
}
