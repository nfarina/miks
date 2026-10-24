import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import type { OpenFile, Tab } from "miks/shared/protocol";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon, type ImageResult } from "./daemon";
import { addCopyButtons, copyCode, markdownCSS, renderMarkdownDocument, resolveLocalPath } from "./markdown";
import { terminalScrollbarCSS } from "./TerminalView";

/**
 * A markdown file in the tab's panel, rendered, following the file as it
 * changes on disk without losing your place. Its images come from the
 * file's Mac (a remote window's too), and its links to files open them here.
 */
export function MarkdownView({
  tab,
  file,
  text,
  onOpenFile,
  onHide,
}: {
  tab: Tab;
  file: OpenFile;
  text: string;
  /** A link to another file (an absolute path on the tab's Mac). */
  onOpenFile: (path: string) => void;
  /** Escape: hides the panel, the file still open in it as it was. */
  onHide: () => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // What's on screen: replaced only when it'd come out different.
  const shownRef = useRef<string | null>(null);
  // Where to stay as the content changes size (images arriving), until
  // you scroll yourself.
  const pinRef = useRef<ScrollPin | null>(null);
  // Images as last read, by path or URL, shown at once while a file's are
  // checked again. Only those the file still has.
  const [images] = useState(() => new Map<string, ShownImage>());
  // Images from the web: how many, and whether you've said to show them
  // (loading one tells its server you're reading this).
  const [webImages, setWebImages] = useState(0);
  const [showWeb, setShowWeb] = useState(false);
  const showWebRef = useRef(showWeb);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;

    const html = renderMarkdownDocument(text);
    const shown = shownRef.current;
    if (shown === html) return;
    shownRef.current = html;

    const pin = shown ? capturePin(scroller, content) : null;
    const template = document.createElement("template");
    template.innerHTML = html;
    // Still inert in the template: no image loads from the window's own origin.
    for (const image of template.content.querySelectorAll("img")) {
      const src = image.getAttribute("src") ?? "";
      image.removeAttribute("srcset");
      // In the file itself (a badge, often), so there's nothing to fetch.
      if (/^data:image\//i.test(src)) continue;
      const local = resolveLocalPath(src, file.path);
      image.removeAttribute("src");
      if (local) image.dataset.path = local;
      else if (/^https?:\/\//i.test(src)) {
        // Until it's shown, its alt text, as a missing one's.
        image.dataset.url = src;
        image.hidden = true;
        const waiting = document.createElement("span");
        waiting.className = "missing web";
        waiting.textContent = image.alt || src.replace(/^https?:\/\//i, "").split("/")[0];
        waiting.title = src;
        image.after(waiting);
      }
    }
    addCopyButtons(template.content.querySelectorAll("pre"));
    content.replaceChildren(template.content);

    const sources = new Set([...content.querySelectorAll<HTMLImageElement>("img[data-path], img[data-url]")].map(imageSource));
    for (const source of images.keys()) if (!sources.has(source)) images.delete(source);

    // Opened from a link to one of its headings.
    const linked = shown ? null : takeHeading(tab.id, file.path);
    const heading = linked ? findHeading(content, linked) : null;

    pinRef.current = heading ? { heading: heading.id, offset: 12 } : pin;
    if (pinRef.current) restorePin(scroller, content, pinRef.current);
    // Each image read once per change, however many times it's shown.
    const reads = new Map<string, Promise<ShownImage | null>>();
    for (const image of content.querySelectorAll<HTMLImageElement>("img[data-path]")) void showImage(image, reads);
    setWebImages(content.querySelectorAll("img[data-url]").length);
    if (showWebRef.current) showWebImages(reads);
  }, [text]);

  function showWebImages(reads?: Map<string, Promise<ShownImage | null>>) {
    showWebRef.current = true;
    setShowWeb(true);
    const shared = reads ?? new Map<string, Promise<ShownImage | null>>();
    for (const image of contentRef.current?.querySelectorAll<HTMLImageElement>("img[data-url]") ?? []) void showImage(image, shared);
  }

  // Open already, and brought to the front by a link to one of its headings:
  // there once it's on show (it may be hidden yet, behind another file).
  const opened = useRef(file.opened);
  useEffect(() => {
    if (opened.current === file.opened) return;
    opened.current = file.opened;
    const linked = takeHeading(tab.id, file.path);
    const heading = linked && contentRef.current ? findHeading(contentRef.current, linked) : null;
    if (!heading) return;
    pinRef.current = { heading: heading.id, offset: 12 };
    requestAnimationFrame(keepPlace);
  }, [file.opened]);

  /** Back to where you were, if the content's moved under you since. */
  function keepPlace() {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (scroller && content && pinRef.current) restorePin(scroller, content, pinRef.current);
  }

  // Anything else changing the content's height (the panel's width, fonts):
  // keep the place you were at, as the content was before.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const observer = new ResizeObserver(() => {
      keepPlace();
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  /**
   * Reads the image from the file's Mac (or the web, from there), showing
   * what it had meanwhile. A file's change checks its own images again
   * (read again only if they changed), but not the web's.
   */
  async function showImage(image: HTMLImageElement, reads: Map<string, Promise<ShownImage | null>>) {
    const { path, url } = image.dataset;
    const source = imageSource(image);
    // A web image's stand-in goes, for it or (failing) a missing one.
    const shown = () => {
      if (image.nextElementSibling?.matches(".missing.web")) image.nextElementSibling.remove();
      image.hidden = false;
    };
    const before = images.get(source);
    if (before) image.src = before.src;
    if (before && url) return shown();

    let read = reads.get(source);
    if (!read) {
      read = path ? readImage(path, before) : fetchImage(source);
      reads.set(source, read);
    }
    const result = await read;
    shown();
    if (!result) {
      images.delete(source);
      // Its alt text, rather than the browser's broken image.
      const missing = document.createElement("span");
      missing.className = "missing";
      missing.textContent = image.alt || source.split("/").pop()!;
      missing.title = `Couldn't show ${source}`;
      return image.replaceWith(missing);
    }
    images.set(source, result);
    if (result.src === before?.src) return;
    image.src = result.src;
    await image.decode().catch(() => {});
    keepPlace();
  }

  function onClick(event: MouseEvent) {
    const target = event.target as HTMLElement;
    if (copyCode(target)) return;

    const link = target.closest("a");
    const href = link?.getAttribute("href");
    if (!link || !href) return;
    event.preventDefault();
    pinRef.current = null;

    const local = resolveLocalPath(href, file.path);
    const hash = href.includes("#") ? decodeHash(href.slice(href.indexOf("#") + 1)) : "";
    if (href.startsWith("#") || local === file.path) {
      // A heading in this file: the content's own, not the window's.
      if (contentRef.current) findHeading(contentRef.current, hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (local) {
      if (hash) pendingHeading = { tabId: tab.id, path: local, id: hash, at: Date.now() };
      onOpenFile(local);
    } else if (/^(https?|mailto):/i.test(href)) {
      // Only the web and mail: the file's markdown, not ours, so no tel:,
      // ftp: and the like that sanitizing lets through, and no `//host`.
      window.open(href);
    }
  }

  return (
    <>
      {webImages > 0 && !showWeb && daemon.speaks(10) && (
        <StyledWebImages>
          <span>
            {webImages === 1 ? "An image" : `${webImages} images`} from the web {webImages === 1 ? "isn't" : "aren't"} shown.
          </span>
          <button onClick={() => showWebImages()}>Show images</button>
        </StyledWebImages>
      )}
    <StyledMarkdownView
      className="markdown-view"
      ref={scrollerRef}
      tabIndex={-1}
      // You scrolling: stay where you put it, not where it was.
      onWheel={() => (pinRef.current = null)}
      onPointerDown={() => (pinRef.current = null)}
      onKeyDown={(event) => {
        pinRef.current = null;
        if (event.key === "Escape") onHide();
      }}
    >
      <div
        className="content"
        ref={contentRef}
        onClick={onClick}
        // A middle click isn't a click: it'd open the link as it is, past onClick.
        onAuxClick={(event) => {
          if ((event.target as HTMLElement).closest("a")) event.preventDefault();
        }}
      />
    </StyledMarkdownView>
    </>
  );
}

/** An image as shown: a data URL, and for one on the daemon's Mac, its file's mtime then. */
type ShownImage = { src: string; mtime?: number };

const imageSource = (image: HTMLImageElement) => image.dataset.path ?? image.dataset.url!;

/** An image on the daemon's Mac, or null if it can't be shown; `known` again if it hasn't changed since. */
async function readImage(path: string, known?: ShownImage): Promise<ShownImage | null> {
  // Older daemons don't answer, so there's no waiting on them.
  if (!daemon.speaks(10)) return null;
  const result = await daemon.readImage(path, known?.mtime);
  return result.unchanged && known ? known : shownImage(result);
}

/** An image from the web, fetched from the daemon's Mac. */
async function fetchImage(url: string): Promise<ShownImage | null> {
  if (!daemon.speaks(10)) return null;
  return shownImage(await daemon.fetchImage(url));
}

const shownImage = (result: ImageResult): ShownImage | null =>
  result.data ? { src: `data:${result.mime};base64,${result.data}`, mtime: result.mtime } : null;

/**
 * Where a link's `#…` goes. Ids get DOMPurify's `user-content-` (as on
 * GitHub), or ones like "links" and "title" would be dropped, being names
 * the document has already.
 */
const findHeading = (content: HTMLElement, hash: string) =>
  content.querySelector<HTMLElement>(`[id="${CSS.escape(`user-content-${hash}`)}"], [id="${CSS.escape(hash)}"]`);

function decodeHash(hash: string): string {
  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

/** A heading in a file a link is opening, to start at once it shows, if that's soon. */
let pendingHeading: { tabId: string; path: string; id: string; at: number } | null = null;

/** Time enough for the file to open, even through a remote's tunnel; past it, it's no longer what you asked for. */
const PENDING_HEADING_MS = 5000;

/** Whether a link is opening this file at one of its headings (the file panel shows it rendered for that). */
export function headingPending(tabId: string, path: string): boolean {
  return !!pendingHeading && pendingHeading.tabId === tabId && pendingHeading.path === path && Date.now() - pendingHeading.at < PENDING_HEADING_MS;
}

/** The heading a link is opening this file at, once: whoever shows it takes it. */
function takeHeading(tabId: string, path: string): string | null {
  if (!headingPending(tabId, path)) return null;
  const id = pendingHeading!.id;
  pendingHeading = null;
  return id;
}

/**
 * Where you are in the file, as a place in it rather than a pixel offset,
 * so text added or taken away above doesn't move you: the bottom (and so
 * following what's added, as with a log), or the heading of the section
 * you're in, or else just how far down you are.
 */
type ScrollPin = { bottom: true } | { heading: string; offset: number } | { top: number };

function capturePin(scroller: HTMLElement, content: HTMLElement): ScrollPin {
  const top = scroller.scrollTop;
  if (top > 0 && top + scroller.clientHeight >= scroller.scrollHeight - 2) return { bottom: true };

  let pin: ScrollPin = { top };
  for (const heading of content.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")) {
    const offset = offsetIn(scroller, heading) - top;
    if (offset > 1) break;
    pin = { heading: heading.id, offset };
  }
  return pin;
}

function restorePin(scroller: HTMLElement, content: HTMLElement, pin: ScrollPin) {
  if ("bottom" in pin) {
    scroller.scrollTop = scroller.scrollHeight;
  } else if ("heading" in pin) {
    const heading = content.querySelector<HTMLElement>(`[id="${CSS.escape(pin.heading)}"]`);
    if (heading) scroller.scrollTop = offsetIn(scroller, heading) - pin.offset;
  } else {
    scroller.scrollTop = pin.top;
  }
}

/** How far down the scroller's content an element is. */
const offsetIn = (scroller: HTMLElement, element: HTMLElement) =>
  element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;

/** Like FileView's bar for a change on disk. */
const StyledWebImages = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  background: ${colors.textBackgroundAlt()};
  border-bottom: 1px solid ${colors.separator()};
  font: ${fonts.display({ size: 12, line: "16px" })};
  color: ${colors.textSecondary()};

  > span {
    flex-grow: 1;
  }

  > button {
    border: none;
    background: none;
    color: ${colors.text()};
    font: ${fonts.displayBold({ size: 12, line: "16px" })};
    cursor: pointer;
  }
`;

const StyledMarkdownView = styled.div`
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
  /* It keeps your place itself (ScrollPin), better than the browser can
     with the content replaced under it. */
  overflow-anchor: none;
  outline: none;
  ${terminalScrollbarCSS()}

  > .content {
    max-width: 820px;
    margin: 0 auto;
    padding: 16px 20px 32px;
    overflow-wrap: break-word;
    user-select: text;
    font: ${fonts.display({ size: 14, line: "22px" })};
    color: ${colors.text()};

    > *:first-child {
      margin-top: 0;
    }

    p,
    ul,
    ol,
    blockquote,
    table,
    > .code,
    > pre {
      margin: 0 0 14px;
    }

    ul,
    ol {
      padding-left: 24px;
    }

    li + li,
    li > ul,
    li > ol {
      margin-top: 4px;
    }

    ${markdownCSS()}

    h1,
    h2,
    h3,
    h4,
    h5,
    h6 {
      margin: 24px 0 12px;
      scroll-margin-top: 12px;
    }
    h1 {
      padding-bottom: 6px;
      border-bottom: 1px solid ${colors.separator()};
      font: ${fonts.displayBold({ size: 24, line: "32px" })};
    }
    h2 {
      padding-bottom: 5px;
      border-bottom: 1px solid ${colors.separator()};
      font: ${fonts.displayBold({ size: 19, line: "26px" })};
    }
    h3 {
      font: ${fonts.displayBold({ size: 16, line: "22px" })};
    }
    h4,
    h5,
    h6 {
      font: ${fonts.displayBold({ size: 14, line: "20px" })};
    }
    h6 {
      color: ${colors.textSecondary()};
    }

    a {
      color: #5b4fd1;
      text-underline-offset: 2px;

      @media (prefers-color-scheme: dark) {
        color: #a8a0ff;
      }
    }

    img {
      max-width: 100%;
    }

    .missing {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 4px;
      border: 1px dashed ${colors.separator()};
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 12, line: "18px" })};
    }

    hr {
      margin: 20px 0;
    }

    pre {
      ${terminalScrollbarCSS()}
    }

    /* Front matter: there, but not the point. */
    pre.frontmatter {
      background: ${colors.textBackgroundAlt()};
      color: ${colors.textSecondary()};
    }

    th,
    td {
      padding: 5px 10px;
    }
  }
`;
