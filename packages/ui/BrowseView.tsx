import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { tooltip } from "crosswing/modals/popup";
import { ArrowLeft, ArrowRight, RotateCw, X } from "lucide-react";
import { browseUrl } from "miks/shared/browse";
import type { OpenPage, Tab } from "miks/shared/protocol";
import { useEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon } from "./daemon";

/** What of Electron's `<webview>` this uses (its types are Electron's, not the page's). */
type Webview = HTMLWebViewElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
};

/**
 * The page `miks browse` put in a tab's panel. It loads through the tab's
 * daemon, as if on its Mac (Electron main gives this window's pages a
 * session whose proxy is the daemon), so in a window on another Mac,
 * `localhost` is that Mac's, on every port.
 */
export function BrowseView({ tab, page, onTitle }: { tab: Tab; page: OpenPage; onTitle: (title: string) => void }) {
  const ref = useRef<Webview>(null);
  const [partition, setPartition] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [address, setAddress] = useState(page.url);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState({ back: false, forward: false });
  // The page it starts on; others are loaded into it, keeping its history.
  const [first] = useState(page.url);
  const ready = useRef(false);

  useEffect(() => {
    void window.miks?.browsePartition().then(setPartition, (error) => setFailed(String(error?.message ?? error)));
  }, []);

  // `miks browse` again, in a tab already showing a page.
  const pageId = useRef(page.id);
  useEffect(() => {
    if (pageId.current === page.id) return;
    pageId.current = page.id;
    go(page.url);
  }, [page.id]);

  useEffect(() => {
    const view = ref.current;
    if (!view) return;

    const update = () => {
      const url = view.getURL();
      if (!editing) setAddress(url);
      setHistory({ back: view.canGoBack(), forward: view.canGoForward() });
      daemon.send({ type: "pageNavigated", tabId: tab.id, url });
    };
    const listeners: [string, (event: any) => void][] = [
      ["dom-ready", () => (ready.current = true)],
      [
        "did-start-loading",
        () => {
          setLoading(true);
          setFailed(null);
        },
      ],
      ["did-stop-loading", () => setLoading(false)],
      ["did-navigate", update],
      ["did-navigate-in-page", (event) => event.isMainFrame && update()],
      ["page-title-updated", (event) => onTitle(event.title)],
      [
        "did-fail-load",
        (event) => {
          // -3 is a load given up for another (a click before it finished).
          if (!event.isMainFrame || event.errorCode === -3) return;
          setFailed(`Couldn't load ${event.validatedURL}: ${event.errorDescription || `error ${event.errorCode}`}.`);
        },
      ],
    ];
    for (const [name, listener] of listeners) view.addEventListener(name, listener);
    return () => {
      for (const [name, listener] of listeners) view.removeEventListener(name, listener);
    };
  }, [partition, editing]);

  function go(input: string) {
    const url = browseUrl(input);
    if (!url) return;
    setAddress(url);
    if (ready.current) void ref.current?.loadURL(url).catch(() => {});
  }

  return (
    <StyledBrowseView>
      <div className="toolbar">
        <button disabled={!history.back} onClick={() => ref.current?.goBack()} {...tooltip("Back", { delay: true })}>
          <ArrowLeft />
        </button>
        <button disabled={!history.forward} onClick={() => ref.current?.goForward()} {...tooltip("Forward", { delay: true })}>
          <ArrowRight />
        </button>
        <button
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          {...tooltip(loading ? "Stop" : "Reload", { delay: true })}
        >
          {loading ? <X /> : <RotateCw />}
        </button>
        <form
          className="address"
          onSubmit={(event) => {
            event.preventDefault();
            setEditing(false);
            go(address);
            ref.current?.focus();
          }}
        >
          <input
            value={address}
            spellCheck={false}
            onFocus={(event) => {
              setEditing(true);
              event.target.select();
            }}
            onBlur={() => {
              setEditing(false);
              if (ready.current && ref.current) setAddress(ref.current.getURL());
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && ref.current) {
                setAddress(ref.current.getURL());
                ref.current.focus();
              }
            }}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button className="close" onClick={() => daemon.send({ type: "closePage", tabId: tab.id })} {...tooltip("Close", { delay: true })}>
          <X />
        </button>
      </div>
      <div className="page">
        {partition && <webview ref={ref} src={first} partition={partition} />}
        {failed && <div className="note">{failed}</div>}
      </div>
    </StyledBrowseView>
  );
}

const StyledBrowseView = styled.div`
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-flow: column;

  > .toolbar {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 6px 10px;
    border-bottom: 1px solid ${colors.separator()};

    > button {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: ${colors.textSecondary()};
      cursor: pointer;

      > svg {
        width: 15px;
        height: 15px;
      }

      &:hover:not(:disabled) {
        background: ${colors.buttonBackgroundGlow()};
        color: ${colors.text()};
      }

      &:disabled {
        opacity: 0.35;
        cursor: default;
      }
    }

    > .address {
      flex-grow: 1;
      min-width: 0;
      margin: 0 4px;

      > input {
        box-sizing: border-box;
        width: 100%;
        height: 26px;
        padding: 0 10px;
        border: 1px solid ${colors.separator()};
        border-radius: 13px;
        background: ${colors.textBackground()};
        color: ${colors.text()};
        font: ${fonts.display({ size: 12, line: "16px" })};
        outline: none;

        &:focus {
          border-color: #5b4fd1;
        }
      }
    }
  }

  > .page {
    flex-grow: 1;
    min-height: 0;
    display: flex;
    position: relative;
    background: #fff;

    > webview {
      flex-grow: 1;
    }

    > .note {
      position: absolute;
      inset: 0;
      padding: 24px;
      background: ${colors.textBackgroundPanel()};
      color: ${colors.textSecondary()};
      font: ${fonts.display({ size: 13, line: "19px" })};
      text-align: center;
    }
  }
`;
