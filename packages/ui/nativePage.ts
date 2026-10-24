import type { MiksBridge, PageState } from "./daemon";

type Listener = (event: any) => void;

/**
 * In the iOS app, a `miks browse` page is a web view of the app's own, over
 * this one (ios/Miks/Pages.swift), kept wherever an element here is, clipped
 * as it is (a panel sliding in), and hidden while it's hidden or something
 * modal (a menu, a dialog) is over it, since it would be drawn over that. It
 * stands in for BrowseView's `<webview>`, by the same methods and events.
 */
export class NativePage {
  private state: PageState;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly unsubscribe: () => void;
  private readonly clippers: HTMLElement[] = [];
  private frame = "";
  private raf = 0;

  constructor(
    private readonly id: string,
    private readonly element: HTMLElement,
    url: string,
    private readonly pages: NonNullable<MiksBridge["pages"]>,
  ) {
    this.state = { id, url, title: "", loading: false, back: false, forward: false };
    this.unsubscribe = pages.onState((state) => state.id === id && this.update(state));
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (getComputedStyle(parent).overflow !== "visible") this.clippers.push(parent);
    }
    pages.tell(id, "open", { url });
    this.follow();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.unsubscribe();
    this.pages.tell(this.id, "close");
  }

  // Each frame, since a panel slides in and the keyboard moves things without
  // anything to observe; told only when it moves.
  private follow = () => {
    this.raf = requestAnimationFrame(this.follow);
    const rect = this.element.getBoundingClientRect();
    let clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (const parent of this.clippers) clip = intersect(clip, parent.getBoundingClientRect());
    clip = intersect(clip, rect);
    const covered = [...document.querySelectorAll("[data-is-modal-root] > *")].some((modal) => covers(modal, clip));
    const visible = !covered && clip.right > clip.left && clip.bottom > clip.top && this.shown();
    const frame = JSON.stringify({
      visible,
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      clip: { x: clip.left, y: clip.top, width: clip.right - clip.left, height: clip.bottom - clip.top },
    });
    if (frame === this.frame) return;
    this.frame = frame;
    this.pages.tell(this.id, "frame", JSON.parse(frame));
  };

  /** Whether it's shown: not hidden (a tab's page not on screen, `visibility: hidden`), or faded out (the panel filling the tab, ⌘⇧F). */
  private shown() {
    if (!this.element.checkVisibility() || getComputedStyle(this.element).visibility !== "visible") return false;
    return !this.ancestors().some((element) => getComputedStyle(element).opacity === "0");
  }

  private ancestors() {
    const ancestors: HTMLElement[] = [];
    for (let element: HTMLElement | null = this.element; element; element = element.parentElement) ancestors.push(element);
    return ancestors;
  }

  private update(next: PageState) {
    const previous = this.state;
    this.state = next;
    if (next.loading && !previous.loading) this.emit("did-start-loading", {});
    if (next.url !== previous.url || next.back !== previous.back || next.forward !== previous.forward) this.emit("did-navigate", {});
    if (next.title !== previous.title) this.emit("page-title-updated", { title: next.title });
    if (!next.loading && previous.loading) this.emit("did-stop-loading", {});
    if (next.failed) this.emit("did-fail-load", { isMainFrame: true, validatedURL: next.url, errorDescription: next.failed });
  }

  private emit(name: string, event: object) {
    this.listeners.get(name)?.forEach((listener) => listener(event));
  }

  addEventListener(name: string, listener: Listener) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)!.add(listener);
  }

  removeEventListener(name: string, listener: Listener) {
    this.listeners.get(name)?.delete(listener);
  }

  loadURL(url: string) {
    this.pages.tell(this.id, "open", { url });
    return Promise.resolve();
  }

  getURL = () => this.state.url;
  canGoBack = () => this.state.back;
  canGoForward = () => this.state.forward;
  goBack = () => this.pages.tell(this.id, "back");
  goForward = () => this.pages.tell(this.id, "forward");
  reload = () => this.pages.tell(this.id, "reload");
  stop = () => this.pages.tell(this.id, "stop");
  focus = () => this.pages.tell(this.id, "focus");
}

/**
 * Whether a modal's in the way: what takes touches, since each kind's layer
 * spans the screen and takes none where nothing is (always there, for
 * toasts), holding what does (a menu) or taking them all (a dialog's).
 */
function covers(element: Element, clip: Box): boolean {
  if (getComputedStyle(element).pointerEvents === "none") return [...element.children].some((child) => covers(child, clip));
  const box = element.getBoundingClientRect();
  return box.left < clip.right && box.right > clip.left && box.top < clip.bottom && box.bottom > clip.top;
}

type Box = { left: number; top: number; right: number; bottom: number };

function intersect(a: Box, b: Box): Box {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}
