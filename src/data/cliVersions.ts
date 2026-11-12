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
}

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

export type CliVersionState = "unknown" | "current" | "behind";

/** "behind" only when the sandbox's CLI is older than the newest published; a newer one (a beta channel) is current. */
export function cliVersionState(info: Pick<CliVersionInfo, "installed" | "latest"> | undefined): CliVersionState {
  if (!info?.installed || !info.latest) return "unknown";
  return compareVersions(info.installed, info.latest) < 0 ? "behind" : "current";
}
