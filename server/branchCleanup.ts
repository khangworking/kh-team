// Tidy agent folders: when a branch is deleted on GitHub (a merged PR's "delete branch", or the user), every
// agent's clone drops its own copy of that branch, reviewers included. Without this each clone keeps a growing
// pile of dead branches, and an agent can start new work from one of them.
//
// Only HQ-managed clones are touched (a folder the user chose is theirs). A branch goes when its upstream is gone
// after `git fetch --prune`, except the one that is checked out. Its tip is logged, so it can be restored with
// `git branch <name> <sha>`; a merged PR's commits also stay on GitHub (refs/pull/<n>/head). A branch with no
// upstream (never pushed) is never touched.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Hub } from "./hub";
import { run } from "./lib/exec";
import { log } from "./lib/log";
import { managedWorkspace } from "./paths";

export interface RemovedBranch {
  name: string;
  sha: string;
}

const GIT = { GIT_TERMINAL_PROMPT: "0" }; // never wait for a password: a clone that can't reach GitHub is skipped

/** Fetches with --prune, then deletes the local branches whose upstream is gone. Never throws. */
export async function removeGoneBranches(dir: string): Promise<{ removed: RemovedBranch[]; error: string | null }> {
  const fetch = await run("git", ["fetch", "--prune", "--quiet", "origin"], { cwd: dir, timeoutMs: 45_000, env: GIT });
  if (!fetch.ok) return { removed: [], error: fetch.stderr.trim().split("\n")[0] || "git fetch failed" };
  const current = (await run("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: dir })).stdout.trim();
  const refs = await run("git", ["for-each-ref", "--format=%(refname:short)%09%(upstream:track)%09%(objectname:short)", "refs/heads"], { cwd: dir });
  if (!refs.ok) return { removed: [], error: refs.stderr.trim().split("\n")[0] || "git for-each-ref failed" };
  const removed: RemovedBranch[] = [];
  for (const line of refs.stdout.split("\n")) {
    const [name, track, sha] = line.split("\t");
    if (!name || track?.trim() !== "[gone]" || name === current) continue;
    // -D: a squash-merged branch is not "merged" as far as git can tell.
    const del = await run("git", ["branch", "-D", name], { cwd: dir });
    if (del.ok) removed.push({ name, sha });
  }
  return { removed, error: null };
}

const DEBOUNCE_MS = 3000;

export class BranchCleanup {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private again = false;

  constructor(private hub: Hub) {}

  /** Cleans every agent's clone soon (once, however many times it is asked: a merge, a Start, a restart). */
  request(delayMs = DEBOUNCE_MS) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), delayMs);
    this.timer.unref();
  }

  async run() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      for (const agent of this.hub.snap.config.team) {
        if (agent.workspacePath) continue; // the user's own folder
        const dir = managedWorkspace(this.hub.slug, agent.id);
        if (!existsSync(join(dir, ".git"))) continue;
        const { removed, error } = await removeGoneBranches(dir);
        if (error) log.info(`branch cleanup skipped for ${agent.name}: ${error}`);
        if (!removed.length) continue;
        const list = removed.map((b) => `${b.name} (${b.sha})`).join(", ");
        log.info(`removed ${removed.length} deleted branch(es) from ${agent.name}'s folder: ${list}`);
        this.hub.activity("config", agent.id, `HQ removed ${removed.length} branch${removed.length === 1 ? "" : "es"} deleted on GitHub from ${agent.name}'s folder: ${removed.map((b) => b.name).join(", ")}`);
      }
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.request();
      }
    }
  }
}
