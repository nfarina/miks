import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { useSyncExternalStore } from "react";
import { styled } from "styled-components";

type Data = typeof import("./fileIconData");

let data: Data | null = null;
let loading = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!loading) {
    loading = true;
    void import("./fileIconData").then((loaded) => {
      data = loaded;
      for (const notify of listeners) notify();
    });
  }
  return () => listeners.delete(listener);
}

/**
 * What the theme calls a file's icon, as VS Code goes about it: the whole
 * name, then each ending, longest first.
 */
function iconName({ manifest }: Data, name: string, dark: boolean): string {
  const lower = name.toLowerCase();
  const light = dark ? null : manifest.light;
  const find = (key: "fileNames" | "fileExtensions", value: string) =>
    (light?.[key] as Record<string, string> | undefined)?.[value] ?? (manifest[key] as Record<string, string>)[value];

  const named = find("fileNames", name) ?? find("fileNames", lower);
  if (named) return named;
  for (let dot = lower.indexOf("."); dot !== -1; dot = lower.indexOf(".", dot + 1)) {
    const icon = find("fileExtensions", lower.slice(dot + 1));
    if (icon) return icon;
  }
  return manifest.file;
}

const sources = new Map<string, string>();

function iconSource(loaded: Data, icon: string) {
  let source = sources.get(icon);
  if (!source) {
    source = `data:image/svg+xml,${encodeURIComponent(loaded.icons[icon] ?? "")}`;
    sources.set(icon, source);
  }
  return source;
}

/** A file's icon by its name, as in VS Code's Material Icon Theme; a folder's is always the plain one. */
export function FileIcon({ name, folder = false, open }: { name: string; folder?: boolean; open?: boolean }) {
  const loaded = useSyncExternalStore(subscribe, () => data);
  const dark = useMatchMedia("(prefers-color-scheme: dark)");
  if (!loaded) return <StyledIcon as="span" />;
  const icon = !folder ? iconName(loaded, name, dark) : open ? loaded.manifest.folderExpanded : loaded.manifest.folder;
  return <StyledIcon alt="" draggable={false} src={iconSource(loaded, icon)} />;
}

const StyledIcon = styled.img`
  flex-shrink: 0;
  width: 16px;
  height: 16px;
`;
