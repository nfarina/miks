import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { type Build, type ClientInfo, PROTOCOL_VERSION, type VersionInfo } from "../shared/protocol.ts";
import { ago, buildLabel, clientKind, installedChanged, windowHere, windowNotes } from "../shared/version.ts";

/** Where the daemon runs from: the repo, or Miks.app's Resources/app. */
const ROOT = path.resolve(import.meta.dirname, "../../..");

/** The bundle it's in, if it's Miks.app's. */
const BUNDLE = ROOT.match(/^(.*?\.app)\//)?.[1] ?? null;

/**
 * Which Miks this is: Miks.app's build.json (scripts/build-app.ts), or in
 * the repo its version and the commit checked out ("+changes" with work not
 * committed yet).
 */
function readBuild(): Build {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "build.json"), "utf8"));
  } catch {}
  let version = "?";
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/app/package.json"), "utf8")).version;
  } catch {}
  let commit: string | null = null;
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 2000 }).trim();
    commit = git("rev-parse", "--short", "HEAD") + (git("status", "--porcelain", "--untracked-files=no") ? "+changes" : "");
  } catch {}
  return { version, commit, built: null };
}

/** This Mac as Sharing settings names it ("Nick's MacBook Air"), as a window's Mac says its own (packages/app/main.ts). */
function machineName(): string {
  try {
    return execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 2000 }).trim();
  } catch {
    return os.hostname().replace(/\.local$/, "");
  }
}

const running = readBuild();
const started = new Date();
const machine = machineName();

/**
 * For `miks version` and its dialog: the Miks this daemon runs, on which
 * Mac and since when; what's installed there now, which it runs only once
 * restarted; and which Miks each window on it is.
 */
export function versionInfo(windows: VersionInfo["windows"]): VersionInfo {
  return {
    machine,
    running,
    protocol: PROTOCOL_VERSION,
    pid: process.pid,
    started: started.toISOString(),
    installed: { ...readBuild(), at: BUNDLE ?? `the repo at ${ROOT.replace(os.homedir(), "~")}` },
    windows,
  };
}

/** `info` as `miks version` prints it, the window typing first; the UI's VersionDialog shows the same. */
export function versionReport(info: VersionInfo, { color }: { color: boolean }): string {
  const { machine, running, installed, windows } = info;
  const style = (code: string) => (text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const bold = style("1");
  const dim = style("2");
  const yellow = style("33");
  const heading = {
    daemon: style("1;36"),
    installed: style("1;35"),
    you: style("1;32"),
    others: style("1;34"),
  };

  const when = (iso: string) => {
    const date = new Date(iso);
    const text = date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    return `${text} ${dim(`(${ago(date)})`)}`;
  };
  const describe = ({ version, commit, built }: Build, { dev = false, label = "Miks" } = {}) =>
    [
      `${label} ${bold(version)}`,
      commit && yellow(commit),
      dev ? dim("dev server") : built ? `built ${when(built)}` : dim("from source"),
    ]
      .filter(Boolean)
      .join("  ");
  const sameAsDaemon = (build: Build) => (build.commit && build.commit === running.commit ? dim("  same as the daemon") : "");

  // A window and its build beneath it, indented by `indent`.
  const describeWindow = (client: ClientInfo | null, indent: string) => {
    if (!client) return dim("An older Miks, which doesn't say which it is");
    const note = windowNotes(client, machine).join(", ");
    return [
      `${clientKind(client)} on ${bold(client.machine)}${note ? dim(`  ${note}`) : ""}`,
      `${indent}${describe(client.ui, { dev: client.ui.dev, label: buildLabel(client) })}${sameAsDaemon(client.ui)}`,
    ].join("\n");
  };

  const sections: string[] = [];

  sections.push(
    [
      `${heading.daemon("Daemon")} on ${bold(machine)}`,
      `  ${describe(running)}`,
      dim(`  Protocol ${info.protocol}, pid ${info.pid}, up since `) + when(info.started),
    ].join("\n"),
  );

  sections.push(
    [
      `${heading.installed("Installed")} on ${bold(machine)}  ${dim(installed.at)}`,
      `  ${describe(installed)}`,
      installedChanged(info)
        ? `  ${yellow("Not what the daemon runs: it runs this once restarted (Miks → Restart daemon…).")}`
        : dim("  Same as the daemon."),
      ...(windowHere(info) ? [] : [dim("  No Miks window open on this Mac.")]),
    ].join("\n"),
  );

  const you = windows.find((w) => w.you);
  if (you) sections.push(`${heading.you("This window")}  ${describeWindow(you.client, "  ")}`);

  const others = windows.filter((w) => !w.you);
  if (others.length) sections.push([heading.others("Also connected"), ...others.map((w) => `  ${describeWindow(w.client, "    ")}`)].join("\n"));

  return `${sections.join("\n\n")}\n`;
}
