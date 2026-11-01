import type { FolderEntry } from "miks/shared/protocol";
import { fitScore } from "./fitScore";

export type TreeFile = { path: string; folder: boolean; ignored?: boolean };

/** A row of the Files tree. `hits` are the letters of `name` that fit a filter, and `score` how well: only files score. */
export type TreeRow = { path: string; name: string; entry: FolderEntry; depth: number; expanded: boolean; hits: number[]; score: number };

type Node = { entry: FolderEntry; children: Map<string, Node> };

/**
 * The rows of the tree under `root` that fit `query`, in the tree's order: the
 * ones whose names fit, and the folders down to them, open. A folder that fits
 * for its own name stays shut, unless something in it fits too. By name, not
 * path, or everything in a folder called `ui` would fit "ui". `files` can repeat
 * a path, and needn't be under `root`; a repeat's `ignored` still counts.
 */
export function filterTree(root: string, files: TreeFile[], query: string): TreeRow[] {
  const top: Node = { entry: { name: "", folder: true }, children: new Map() };
  const prefix = root === "/" ? "/" : `${root}/`;
  for (const { path, folder, ignored } of files) {
    if (!path.startsWith(prefix)) continue;
    const names = path.slice(prefix.length).split("/");
    let node = top;
    names.forEach((name, index) => {
      const last = index === names.length - 1;
      let child = node.children.get(name);
      if (!child) node.children.set(name, (child = { entry: { name, folder: !last || folder }, children: new Map() }));
      if (last && ignored) child.entry = { ...child.entry, ignored };
      node = child;
    });
  }

  const score = ({ entry }: Node, fit: { score: number } | null) => (fit && !entry.folder ? fit.score : -Infinity);

  const walk = (node: Node, path: string, depth: number): TreeRow[] =>
    [...node.children.values()]
      .sort(
        (a, b) =>
          Number(b.entry.folder) - Number(a.entry.folder) ||
          a.entry.name.localeCompare(b.entry.name, undefined, { numeric: true, sensitivity: "base" }),
      )
      .flatMap((child) => {
        const { name } = child.entry;
        const childPath = `${path}${name}`;
        const below = walk(child, `${childPath}/`, depth + 1);
        const fit = fitScore(query, name);
        if (!fit && below.length === 0) return [];
        return [{ path: childPath, name, entry: child.entry, depth, expanded: below.length > 0, hits: fit?.hits ?? [], score: score(child, fit) }, ...below];
      });
  return walk(top, prefix, 0);
}
