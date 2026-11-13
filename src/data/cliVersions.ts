// What version of its coding CLI each agent's sandbox has, against the newest one published.
// Shared by the server (which asks) and the UI (which shows it).

import type { AgentCli } from "./types";

/** Where each CLI is published (npm's "latest" tag is the stable release). */
export const NPM_PACKAGE: Record<AgentCli, string> = { claude: "@anthropic-ai/claude-code", codex: "@openai/codex", opencode: "opencode-ai" };

/** One agent's CLI: the version in its sandbox (null = not asked yet or unreadable) and the newest published. */
export interface CliVersionInfo {
  cli: AgentCli;
  installed: string | null;
  latest: string | null;
  /** When the installed version was read (ISO), so a stopped agent shows what its sandbox had last time. */
  checkedAt: string | null;
  /** The version the agent is pinned to (null = follows the newest). */
  pinned?: string | null;
  /** An upgrade is running in the agent's sandbox. */
  upgrading?: boolean;
  /** Why the last upgrade failed (cleared by the next one). */
  error?: string | null;
}

/**
 * Which published line a CLI belongs to. OpenCode 2 is released apart from OpenCode 1 (npm's "latest" tag is still 1.x),
 * so a sandbox on 2.x is compared with the newest 2.x.
 */
export type CliLine = AgentCli | "opencode2";
export const cliLine = (cli: AgentCli, installed: string | null): CliLine => (cli === "opencode" && installed && parseInt(installed, 10) >= 2 ? "opencode2" : cli);

/** The first x.y.z in a CLI's --version output ("2.1.322 (Claude Code)", "codex-cli 0.167.0", "1.19.0"). */
export function parseVersion(text: string): string | null {
  return text.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** <0, 0, >0 like a sort comparator, on the numeric parts. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** "0.167.0": what a pin may be. */
export const isVersion = (v: unknown): v is string => typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v);

export type CliVersionState = "unknown" | "current" | "behind" | "off-pin";

/**
 * Pinned: "current" only on exactly the pinned version, otherwise "off-pin" (older or newer: both are wrong).
 * Not pinned: "behind" only when the sandbox's CLI is older than the newest published; a newer one (a beta channel) is current.
 */
export function cliVersionState(info: Pick<CliVersionInfo, "installed" | "latest" | "pinned"> | undefined): CliVersionState {
  if (!info?.installed) return "unknown";
  if (info.pinned) return info.installed === info.pinned ? "current" : "off-pin";
  if (!info.latest) return "unknown";
  return compareVersions(info.installed, info.latest) < 0 ? "behind" : "current";
}

/** The version HQ would install: the pin, else the newest published. */
export const cliTarget = (info: Pick<CliVersionInfo, "latest" | "pinned"> | undefined): string | null => info?.pinned || info?.latest || null;

/** An install would change something. */
export const cliNeedsInstall = (state: CliVersionState): boolean => state === "behind" || state === "off-pin";
