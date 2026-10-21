import type { Background } from "./protocol.ts";

/** Background work as Claude Code's footer says it: "1 shell, 2 monitors". Nothing for none. */
export function describeBackground(background: Background | undefined): string | null {
  if (!background) return null;
  const parts = [
    [background.shells, "shell"],
    [background.monitors, "monitor"],
    [background.agents, "agent"],
  ] as const;
  const described = parts.filter(([count]) => count > 0).map(([count, noun]) => `${count} ${noun}${count === 1 ? "" : "s"}`);
  return described.length > 0 ? described.join(", ") : null;
}

/** The work of several sessions, added up. */
export function totalBackground(backgrounds: (Background | undefined)[]): Background {
  const total: Background = { shells: 0, monitors: 0, agents: 0 };
  for (const background of backgrounds) {
    total.shells += background?.shells ?? 0;
    total.monitors += background?.monitors ?? 0;
    total.agents += background?.agents ?? 0;
  }
  return total;
}
