/** How well one word fits a path: see `fitScore`. */
function fitWord(word: string, path: string): { score: number; hits: number[] } | null {
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const hits: number[] = [];
  let score = 0;
  const whole = word.toLowerCase();
  // There as it's typed, that's the place, the last being the closest to the
  // file's name. Otherwise in order from the left, which is close, and cheap.
  let at = Math.max(0, lower.lastIndexOf(whole));
  for (const char of whole) {
    const found = lower.indexOf(char, at);
    if (found === -1) return null;
    const before = path[found - 1];
    if (hits.at(-1) === found - 1) score += 4;
    if (found === 0 || "/._-".includes(before ?? "") || (/[A-Z]/.test(path[found]) && /[a-z]/.test(before ?? ""))) score += 3;
    if (found >= nameStart) score += 2;
    hits.push(found);
    at = found + 1;
  }
  return { score, hits };
}

/**
 * How well `query` fits `path`, or null if it doesn't. Each word, as in VS
 * Code, fits on its own, its letters in order, in any order with the others:
 * `chat ui` finds `packages/ui/ChatPanel.tsx`. Higher for runs of letters, for
 * starts of words, and for landing in the file's name; a little lower for a
 * longer path.
 */
export function fitScore(query: string, path: string): { score: number; hits: number[] } | null {
  let score = -path.length / 100;
  const hits: number[] = [];
  for (const word of query.split(/\s+/).filter(Boolean)) {
    const fit = fitWord(word, path);
    if (!fit) return null;
    score += fit.score;
    hits.push(...fit.hits);
  }
  return { score, hits };
}
