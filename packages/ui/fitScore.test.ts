import { describe, expect, it } from "vitest";
import { fitScore } from "./fitScore";

describe("fitScore", () => {
  it("fits letters in order", () => {
    expect(fitScore("cpn", "ui/ChatPanel.tsx")).not.toBeNull();
    expect(fitScore("npc", "ui/ChatPanel.tsx")).toBeNull();
  });

  it("fits each word on its own, in any order", () => {
    const path = "packages/ui/ChatPanel.tsx";
    expect(fitScore("chat ui", path)?.hits).toEqual([12, 13, 14, 15, 9, 10]);
    expect(fitScore("ui chat", path)).not.toBeNull();
  });

  it("narrows by every word", () => {
    expect(fitScore("chat daemon", "packages/ui/ChatPanel.tsx")).toBeNull();
    expect(fitScore("chat daemon", "packages/daemon/ChatPanel.tsx")).not.toBeNull();
  });

  it("takes any path for no words, shorter first", () => {
    expect(fitScore("  ", "a/b.ts")!.score).toBeGreaterThan(fitScore("", "a/longer/b.ts")!.score);
  });
});
