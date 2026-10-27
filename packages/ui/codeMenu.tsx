// A click on code in a message (`like/this`) offers what it could be:
// copying it, and if it's a path there on the tab's Mac, opening it (in the
// panel, or a folder in Finder) and showing it in Finder; if a web address,
// opening that. Links stay links: this is only for code.
import { PopupMenu, PopupMenuText } from "crosswing/components/PopupMenu";
import { usePopup } from "crosswing/modals/popup/usePopup";
import { Copy, ExternalLink, FileText, FolderOpen, FolderSearch } from "lucide-react";
import { type MouseEvent } from "react";
import { daemon, type FoundPath, isRemote } from "./daemon";
import { openLink } from "./links";
import { DEVICE_SETTINGS } from "./settings";

/** How long the menu waits on the daemon to say whether it's a path, before showing without. */
const LOOKUP_MS = 800;

export function useCodeMenu(tabId: string): { onClick: (event: MouseEvent) => boolean } {
  const menu = usePopup((code: string, found: FoundPath) => {
    // Finder only where Finder is: a Miks window on this Mac.
    const finder = !DEVICE_SETTINGS && !isRemote();
    return (
      <PopupMenu>
        {isWebAddress(code) && <PopupMenuText icon={<ExternalLink />} onClick={() => openLink(code, tabId)} children="Open link" />}
        {found && !found.folder && (
          <PopupMenuText
            icon={<FileText />}
            onClick={() => daemon.send({ type: "openFile", tabId, path: found.path })}
            children="Open"
          />
        )}
        {found?.folder && finder && (
          <PopupMenuText
            icon={<FolderOpen />}
            onClick={() => daemon.send({ type: "showFolder", path: found.path })}
            children="Open"
          />
        )}
        {found && finder && daemon.speaks(18) && (
          <PopupMenuText
            icon={<FolderSearch />}
            onClick={() => daemon.send({ type: "showFolder", path: found.path, reveal: true })}
            children="Reveal in Finder"
          />
        )}
        <PopupMenuText icon={<Copy />} onClick={() => window.miks?.copy(code)} children="Copy" />
      </PopupMenu>
    );
  });

  /** For a click in a message: whether it was on code, which it then takes. */
  function onClick(event: MouseEvent): boolean {
    const element = (event.target as HTMLElement).closest("code");
    // Code blocks have their Copy button; code in a link is the link's.
    if (!element || element.closest("pre, a")) return false;
    // A click that ended selecting some of it.
    if (!window.getSelection()?.isCollapsed) return true;
    if (menu.visible) {
      menu.hide();
      return true;
    }

    const code = element.textContent ?? "";
    const target = { current: element };
    void lookUp(tabId, code).then((found) => {
      // Gone from the page (the conversation moved on) while it looked.
      if (element.isConnected) menu.show(target, code, found);
    });
    return true;
  }

  return { onClick };
}

/** The path code is on the tab's Mac, if it could be one and is there. */
function lookUp(tabId: string, code: string): Promise<FoundPath> {
  const text = code.trim();
  if (!text || text.length > 1024 || /\s/.test(text) || isWebAddress(text)) return Promise.resolve(null);
  const timeout = new Promise<FoundPath>((resolve) => setTimeout(() => resolve(null), LOOKUP_MS));
  return Promise.race([daemon.findPaths(tabId, [text]).then(([found]) => found ?? null), timeout]);
}

const isWebAddress = (text: string) => /^https?:\/\/\S+$/.test(text.trim());
