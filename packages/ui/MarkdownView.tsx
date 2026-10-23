import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import type { OpenFile, Tab } from "miks/shared/protocol";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";
import { highlightCSS, renderMarkdownDocument, resolveLocalPath, taskListCSS } from "./markdown";

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
  // Images as last read, shown at once while they're read again.
  const [images] = useState(() => new Map<string, string>());

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
      const local = resolveLocalPath(image.getAttribute("src") ?? "", file.path);
      if (local) {
        image.removeAttribute("src");
        image.dataset.path = local;
      }
    }
    for (const pre of template.content.querySelectorAll("pre")) {
      const wrapper = document.createElement("div");
      wrapper.className = "code";
      pre.replaceWith(wrapper);
      const button = document.createElement("button");
      button.className = "copy";
      button.textContent = "Copy";
      wrapper.append(pre, button);
    }
    content.replaceChildren(template.content);

    // Opened from a link to one of its headings.
    const linked = !shown && pendingHeading?.tabId === tab.id && pendingHeading.path === file.path ? pendingHeading.id : null;
    if (!shown) pendingHeading = null;
    const heading = linked ? findHeading(content, linked) : null;

    pinRef.current = heading ? { heading: heading.id, offset: 12 } : pin;
    if (pinRef.current) restorePin(scroller, content, pinRef.current);
    // Each image read once per change, however many times it's shown.
    const reads = new Map<string, Promise<string | null>>();
    for (const image of content.querySelectorAll<HTMLImageElement>("img[data-path]")) void showImage(image, reads);
  }, [text]);

  // Open already, and brought to the front by a link to one of its headings:
  // there once it's on show (it may be hidden yet, behind another file).
  const opened = useRef(file.opened);
  useEffect(() => {
    if (opened.current === file.opened) return;
    opened.current = file.opened;
    if (pendingHeading?.tabId !== tab.id || pendingHeading.path !== file.path || !contentRef.current) return;
    const heading = findHeading(contentRef.current, pendingHeading.id);
    pendingHeading = null;
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

  /** Reads the image from the file's Mac, showing what it had meanwhile. */
  async function showImage(image: HTMLImageElement, reads: Map<string, Promise<string | null>>) {
    const path = image.dataset.path!;
    const before = images.get(path);
    if (before) image.src = before;

    let read = reads.get(path);
    if (!read) {
      read = readImage(path);
      reads.set(path, read);
    }
    const src = await read;
    if (!src) {
      images.delete(path);
      // Its alt text, rather than the browser's broken image.
      const missing = document.createElement("span");
      missing.className = "missing";
      missing.textContent = image.alt || path.split("/").pop()!;
      missing.title = `Couldn't show ${path}`;
      return image.replaceWith(missing);
    }
    images.set(path, src);
    if (src === before) return;
    image.src = src;
    await image.decode().catch(() => {});
    keepPlace();
  }

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
      if (hash) pendingHeading = { tabId: tab.id, path: local, id: hash };
      onOpenFile(local);
    } else if (/^(https?|mailto):/i.test(href)) {
      // Only the web and mail: the file's markdown, not ours, so no tel:,
      // ftp: and the like that sanitizing lets through, and no `//host`.
      window.open(href);
    }
  }

  return (
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
  );
}

/** An image on the daemon's Mac, as a data URL, or null if it can't be shown. */
async function readImage(path: string): Promise<string | null> {
  // Older daemons don't answer, so there's no waiting on them.
  if ((daemon.getSnapshot().state?.protocol ?? 0) < 10) return null;
  const result = await daemon.readImage(path);
  return result.data ? `data:${result.mime};base64,${result.data}` : null;
}

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

/** A heading in a file a link is opening, to start at once it shows. */
let pendingHeading: { tabId: string; path: string; id: string } | null = null;

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

const StyledMarkdownView = styled.div`
  flex-grow: 1;
  min-height: 0;
  overflow-y: auto;
  /* It keeps your place itself (ScrollPin), better than the browser can
     with the content replaced under it. */
  overflow-anchor: none;
  outline: none;
  /* macOS's own scroll bars, dark in dark mode. */
  color-scheme: light dark;

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

    ${taskListCSS()}

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

    blockquote {
      padding-left: 12px;
      border-left: 3px solid ${colors.separator()};
      color: ${colors.textSecondary()};
    }

    hr {
      border: none;
      border-top: 1px solid ${colors.separator()};
      margin: 20px 0;
    }

    .code {
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

    /* Front matter: there, but not the point. */
    pre.frontmatter {
      background: ${colors.textBackgroundAlt()};
      color: ${colors.textSecondary()};
    }

    code:not(pre > code) {
      padding: 1px 4px;
      border-radius: 4px;
      background: ${colors.textBackground()};
      border: 1px solid ${colors.separator()};
      overflow-wrap: anywhere;
      font: ${fonts.displayMono({ size: 12.5, line: "18px" })};
    }

    table {
      border-collapse: collapse;
      display: block;
      overflow-x: auto;
      max-width: 100%;
      font: ${fonts.display({ size: 13, line: "19px" })};

      th,
      td {
        padding: 5px 10px;
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
`;
