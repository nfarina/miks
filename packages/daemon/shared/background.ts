import type { Background, RunningProgram } from "./protocol.ts";
import { displayPath } from "./settings.ts";

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

/**
 * What's running, a line each ("claude in sage (mid-task, 1 shell)"). With
 * `restored` (the daemon is stopping but its layout comes back: a restart,
 * or Miks opening again), only what that would lose: programs that won't
 * come back, and ones that will but are mid-task (a Claude turn).
 */
export function describeRunning(
  running: RunningProgram[],
  { restored = false, prefix, home }: { restored?: boolean; prefix: string; home: string | null },
): string[] {
  return (
    running
      // A daemon from before `kept` comes back with nothing. A resumed
      // Claude session doesn't start its background work again.
      .filter(({ kept, active, background }) => !restored || !kept || active || background)
      .map(({ program, cwd, kept, active, background }) => {
        const where = cwd ? ` in ${displayPath(cwd, prefix, home)}` : "";
        const notes = [restored && kept && active && "mid-task", describeBackground(background)].filter(Boolean);
        return `${program}${where}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
      })
  );
}
